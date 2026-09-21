import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Flowable, Frame, PageBreak, PageTemplate, Paragraph,
    Spacer, Table, TableStyle,
)

ROOT = Path(r"C:\Users\jesus\projects\Arca-back")
DATA = ROOT / "output/diag/score-cached-gallardo.json"
REPLAY = ROOT / "output/diag/post-fix-replay.json"
OUT = ROOT / "output/pdf/resultados-score-cache-apify-gallardo.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

score_data = json.loads(DATA.read_text(encoding="utf-8-sig"))
replay = json.loads(REPLAY.read_text(encoding="utf-8-sig"))
original = score_data["original"]
cached = score_data["cached"]
sources = score_data["sources"]
signals = score_data["signals"]

font_dir = Path(r"C:\Windows\Fonts")
pdfmetrics.registerFont(TTFont("Arial", str(font_dir / "arial.ttf")))
pdfmetrics.registerFont(TTFont("Arial-Bold", str(font_dir / "arialbd.ttf")))

NAVY = colors.HexColor("#102A43")
BLUE = colors.HexColor("#2563EB")
GREEN = colors.HexColor("#15803D")
AMBER = colors.HexColor("#B45309")
RED = colors.HexColor("#B91C1C")
INK = colors.HexColor("#243B53")
MUTED = colors.HexColor("#627D98")
LINE = colors.HexColor("#D9E2EC")
PALE = colors.HexColor("#F5F8FC")
PALE_BLUE = colors.HexColor("#EAF2FF")
PALE_GREEN = colors.HexColor("#ECFDF3")
PALE_AMBER = colors.HexColor("#FFF7ED")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="TitleX", fontName="Arial-Bold", fontSize=24, leading=28, textColor=NAVY, spaceAfter=8))
styles.add(ParagraphStyle(name="SubtitleX", fontName="Arial", fontSize=10.5, leading=15, textColor=MUTED, spaceAfter=15))
styles.add(ParagraphStyle(name="H1X", fontName="Arial-Bold", fontSize=17, leading=21, textColor=NAVY, spaceBefore=5, spaceAfter=9, keepWithNext=True))
styles.add(ParagraphStyle(name="H2X", fontName="Arial-Bold", fontSize=12.5, leading=16, textColor=INK, spaceBefore=7, spaceAfter=5, keepWithNext=True))
styles.add(ParagraphStyle(name="BodyX", fontName="Arial", fontSize=9.2, leading=13.4, textColor=INK, spaceAfter=6))
styles.add(ParagraphStyle(name="SmallX", fontName="Arial", fontSize=7.7, leading=10.5, textColor=INK))
styles.add(ParagraphStyle(name="TinyX", fontName="Arial", fontSize=6.6, leading=8.7, textColor=INK))
styles.add(ParagraphStyle(name="TinyBoldX", fontName="Arial-Bold", fontSize=6.6, leading=8.7, textColor=INK))
styles.add(ParagraphStyle(name="HeaderX", fontName="Arial-Bold", fontSize=6.6, leading=8.7, textColor=colors.white))
styles.add(ParagraphStyle(name="KpiX", fontName="Arial-Bold", fontSize=17, leading=19, textColor=NAVY, alignment=TA_CENTER))
styles.add(ParagraphStyle(name="KpiLabelX", fontName="Arial", fontSize=7.3, leading=9.2, textColor=MUTED, alignment=TA_CENTER))


def esc(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def p(value, style="BodyX"):
    return Paragraph(esc(value), styles[style])


def rich(value, style="BodyX"):
    return Paragraph(value, styles[style])


class ScoreBar(Flowable):
    def __init__(self, score, maximum, width=47 * mm, height=7 * mm, color=BLUE):
        super().__init__()
        self.score = score
        self.maximum = maximum
        self.width = width
        self.height = height
        self.color = color

    def draw(self):
        canvas = self.canv
        canvas.setFillColor(colors.HexColor("#E6EDF5"))
        canvas.roundRect(0, 0, self.width, self.height, 2 * mm, fill=1, stroke=0)
        fill = self.width * max(0, min(self.score / self.maximum if self.maximum else 0, 1))
        if fill:
            canvas.setFillColor(self.color)
            canvas.roundRect(0, 0, fill, self.height, 2 * mm, fill=1, stroke=0)
        canvas.setFillColor(INK)
        canvas.setFont("Arial-Bold", 7.4)
        canvas.drawCentredString(self.width / 2, 2.05 * mm, f"{self.score}/{self.maximum}")


def header_footer(canvas, doc):
    canvas.saveState()
    width, _height = A4
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 15 * mm, width - 18 * mm, 15 * mm)
    canvas.setFont("Arial", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 9.5 * mm, "Arca — recálculo offline con evidencia Apify guardada")
    canvas.drawRightString(width - 18 * mm, 9.5 * mm, f"Página {doc.page}")
    canvas.restoreState()


def styled_table(rows, widths, header=True, font_size="SmallX", row_colors=None):
    if header:
        rows = [[Paragraph(esc(cell.getPlainText() if isinstance(cell, Paragraph) else cell), styles["HeaderX"])
                 for cell in rows[0]], *rows[1:]]
    table = Table(rows, colWidths=widths, repeatRows=1 if header else 0, splitByRow=1)
    commands = [
        ("GRID", (0, 0), (-1, -1), 0.4, LINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    if header:
        commands += [("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white)]
    if row_colors:
        for index, color in enumerate(row_colors, start=1 if header else 0):
            commands.append(("BACKGROUND", (0, index), (-1, index), color))
    else:
        commands.append(("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [colors.white, PALE]))
    table.setStyle(TableStyle(commands))
    return table


CATEGORY_LABELS = {
    "aiGovernance": "Gobierno de IA",
    "professionalStanding": "Situación profesional",
    "reputation": "Reputación",
    "firmMaturity": "Madurez de la firma",
}

RULE_LABELS = {
    "W1": "Política de IA", "W2": "IA en servicios", "W3": "Divulgación de IA", "W4": "Contenido sobre IA",
    "B1": "Abogados activos", "B2_clean": "Historial disciplinario limpio", "B3": "Consistencia con el Bar",
    "B4": "Experiencia promedio", "B2_sanction": "Penalización por sanciones",
    "A1": "Calificación Avvo", "A3": "Reseñas Avvo", "A6": "Premios Avvo",
    "W7": "Calidad del sitio", "W6": "Privacidad", "W5a": "Página de equipo", "W8": "Antigüedad",
    "W9_A2": "Coherencia de áreas",
}

RULE_EXPLANATIONS = {
    "W1": "No se confirmó una política de IA.",
    "W2": "No se confirmó uso de IA en los servicios.",
    "W3": "No se confirmó divulgación de IA.",
    "W4": "No se confirmó contenido propio sobre IA.",
    "B1": "21 perfiles encontrados están activos; faltan 4, por lo que no se afirma que los 25 estén activos.",
    "B2_clean": "Los registros guardados no contienen detalle disciplinario concluyente.",
    "B3": "21 de 25 integrantes tienen match: consistencia 0.84, superior al umbral 0.80.",
    "B4": "Experiencia promedio 7.41 años; queda entre los umbrales de bonificación y penalización.",
    "B2_sanction": "No existe evidencia suficiente para aplicar o descartar una sanción.",
    "A1": "Promedio 6.875 entre los perfiles que aportan rating; corresponde a +2.",
    "A3": "Promedio 4.06 y 17 reseñas acumuladas; corresponde a +5.",
    "A6": "Se observaron 6 premios, concentrados en un perfil; corresponde a +6.",
    "W7": "El sitio fue clasificado como robusto.",
    "W6": "La política de privacidad quedó sin evidencia concluyente.",
    "W5a": "La página de equipo tiene perfiles enlazados para 25/25 integrantes.",
    "W8": "La firma declara fundación en 2012; supera 10 años.",
    "W9_A2": "El sitio no entregó áreas estructuradas para contrastarlas con Avvo.",
}

doc = BaseDocTemplate(str(OUT), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
                      topMargin=18 * mm, bottomMargin=19 * mm,
                      title="Score con evidencia Apify guardada — Gallardo Law Firm",
                      author="Arca / Codex")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
doc.addPageTemplates([PageTemplate(id="main", frames=frame, onPage=header_footer)])

story = [Spacer(1, 8 * mm), rich("REPORTE DE RECÁLCULO", "SmallX"),
         p("Score con datos guardados de Apify", "TitleX"),
         p("Gallardo Law Firm | código de matching corregido | 15 de septiembre de 2026", "SubtitleX")]

kpis = [
    [p("SCORE", "KpiLabelX"), p("COBERTURA BAR", "KpiLabelX"), p("COBERTURA AVVO", "KpiLabelX")],
    [p("27/100", "KpiX"), p("21/25", "KpiX"), p("21/25", "KpiX")],
    [p("antes: 11/100", "KpiLabelX"), p("84%", "KpiLabelX"), p("84% · fuente parcial", "KpiLabelX")],
]
kt = Table(kpis, colWidths=[57.3 * mm] * 3, rowHeights=[8 * mm, 12 * mm, 9 * mm])
kt.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (0, -1), PALE_BLUE), ("BACKGROUND", (1, 0), (1, -1), PALE_GREEN),
    ("BACKGROUND", (2, 0), (2, -1), PALE_AMBER), ("BOX", (0, 0), (-1, -1), 0.6, LINE),
    ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
]))
story += [kt, Spacer(1, 8 * mm), p("Resultado ejecutivo", "H1X"),
          rich("El score sube de <b>11 a 27</b>. La mejora proviene de recuperar perfiles que Apify ya había entregado: la consistencia del Florida Bar pasa de 12% a 84%, y Avvo aporta suficientes datos agregados para puntuar reseñas y premios.", "BodyX")]

callout = Table([[rich("<b>Lectura correcta:</b> el tier numérico cambia de CRITICAL a EXPOSED, pero la decisión continúa en UNKNOWN porque el assessment sigue en INSUFFICIENT_EVIDENCE.", "BodyX")]], colWidths=[172 * mm])
callout.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PALE_AMBER), ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#FDBA74")),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                                  ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
story += [callout, Spacer(1, 6 * mm), p("Comparación por categoría", "H2X")]

category_rows = [[p("Categoría", "TinyBoldX"), p("Original", "TinyBoldX"), p("Recalculado", "TinyBoldX"), p("Cambio", "TinyBoldX"), p("Estado", "TinyBoldX")]]
for key in CATEGORY_LABELS:
    old = original["categories"][key]
    new = cached["categories"][key]
    delta = new["score"] - old["score"]
    category_rows.append([p(CATEGORY_LABELS[key], "SmallX"), ScoreBar(old["score"], old["max"], 31 * mm, color=MUTED),
                          ScoreBar(new["score"], new["max"], 31 * mm, color=GREEN if delta > 0 else BLUE),
                          p(f"{delta:+d}", "SmallX"), p(new["status"], "SmallX")])
story += [styled_table(category_rows, [37 * mm, 35 * mm, 35 * mm, 20 * mm, 45 * mm]), Spacer(1, 6 * mm),
          p("Procedencia y costo", "H2X"),
          p("Se reutilizaron raw-bar.json, raw-avvo.json y la extracción web del E2E original. No se inició ningún actor ni se llamó al modelo."),
          rich("Costo histórico de la evidencia Apify: <b>USD 2.1375</b>. Costo incremental del recálculo: <b>USD 0</b>.", "BodyX"), PageBreak()]

story += [p("Detalle de reglas", "H1X"), Spacer(1, 2 * mm),
          p("Los signos de interrogación indican evidencia desconocida; no equivalen a cero probado.")]

rule_rows = [[p("Categoría", "TinyBoldX"), p("Regla", "TinyBoldX"), p("Pts", "TinyBoldX"), p("Justificación", "TinyBoldX")]]
for category_key in CATEGORY_LABELS:
    category = cached["categories"][category_key]
    for rule in category["rules"]:
        points = "?" if rule["points"] is None else f"{rule['points']:+d}"
        rule_rows.append([p(CATEGORY_LABELS[category_key], "TinyX"),
                          p(f"{rule['id']} — {RULE_LABELS[rule['id']]}", "TinyX"),
                          p(points, "TinyBoldX"), p(RULE_EXPLANATIONS[rule["id"]], "TinyX")])
story += [styled_table(rule_rows, [34 * mm, 48 * mm, 13 * mm, 77 * mm]), PageBreak()]

story += [p("Cobertura y señales observadas", "H1X"), p("Florida Bar", "H2X")]
bar_rows = [
    [p("Métrica", "TinyBoldX"), p("Resultado", "TinyBoldX"), p("Interpretación", "TinyBoldX")],
    [p("Matches", "SmallX"), p("21/25", "SmallX"), p("La consistencia sube a 0.84.", "SmallX")],
    [p("Estado profesional", "SmallX"), p("21 activos", "SmallX"), p("Los cuatro faltantes impiden afirmar B1 para todo el roster.", "SmallX")],
    [p("Experiencia", "SmallX"), p("7.41 años", "SmallX"), p("B4 pasa de +3 a 0 porque ahora incluye muchos abogados recientes.", "SmallX")],
    [p("Disciplina", "SmallX"), p("Desconocida", "SmallX"), p("Los registros no aportan detalle suficiente para B2.", "SmallX")],
]
story += [styled_table(bar_rows, [45 * mm, 38 * mm, 89 * mm]), Spacer(1, 6 * mm), p("Avvo", "H2X")]

avvo_rows = [
    [p("Métrica", "TinyBoldX"), p("Resultado", "TinyBoldX"), p("Cobertura real", "TinyBoldX")],
    [p("Matches", "SmallX"), p("21/25", "SmallX"), p("17 consultas originales alcanzaron el límite de resultados.", "SmallX")],
    [p("Rating", "SmallX"), p("6.875", "SmallX"), p("Disponible en 4 de 21 perfiles aceptados.", "SmallX")],
    [p("Reseñas", "SmallX"), p("4.06 / 17 reseñas", "SmallX"), p("Disponible en 5 de 21 perfiles aceptados.", "SmallX")],
    [p("Premios", "SmallX"), p("6", "SmallX"), p("Los seis pertenecen a Jesus Novo; awardsCount está informado en los 21.", "SmallX")],
]
story += [styled_table(avvo_rows, [45 * mm, 38 * mm, 89 * mm]), Spacer(1, 6 * mm),
          p("Personas aún no resueltas", "H2X")]

missing_rows = [
    [p("Nombre", "TinyBoldX"), p("Bar", "TinyBoldX"), p("Avvo", "TinyBoldX")],
    [p("Christopher Rivera", "SmallX"), p("Candidato ajeno", "SmallX"), p("10/10 resultados; ningún Christopher Rivera", "SmallX")],
    [p("Lorena Gaona Krewson", "SmallX"), p("Dos coincidencias fonéticas ajenas", "SmallX"), p("10/10 Lorenas; ningún Gaona/Krewson", "SmallX")],
    [p("Mariangeli Mercado", "SmallX"), p("No lawyers matched", "SmallX"), p("Dos Mercado ajenos; lote no truncado", "SmallX")],
    [p("Nelson Vladimir Jaramillo", "SmallX"), p("No lawyers matched", "SmallX"), p("10/10 resultados parciales por Vladimir o Jaramillo", "SmallX")],
]
story += [styled_table(missing_rows, [47 * mm, 52 * mm, 73 * mm]), PageBreak()]

story += [p("Limitaciones y decisión", "H1X"), Spacer(1, 2 * mm),
          p("Por qué la decisión sigue en UNKNOWN", "H2X")]
flags = [
    ("INCOMPLETE_SOURCES", "Avvo conserva estado PARTIAL/TRUNCATED."),
    ("PARTIAL_ATTORNEY_DATA", "Numerosos perfiles carecen de ratings, reseñas o detalle disciplinario."),
    ("INCOMPLETE_EVIDENCE", "Gobierno de IA, privacidad, disciplina y coherencia de áreas siguen sin resolverse."),
    ("COMMERCIAL_DECISION_BLOCKED", "El contrato impide emitir una decisión mientras el assessment sea insuficiente."),
]
flag_rows = [[p("Bandera", "TinyBoldX"), p("Causa", "TinyBoldX")]] + [[p(flag, "SmallX"), p(reason, "SmallX")] for flag, reason in flags]
story += [styled_table(flag_rows, [64 * mm, 108 * mm]), Spacer(1, 7 * mm)]

warning = Table([[rich("<b>Riesgo de interpretación:</b> Reputation aparece como KNOWN y aporta 13 puntos aunque el rating solo esté presente en 4/21 perfiles y las reseñas en 5/21. El scorer actual calcula sobre valores no nulos sin exigir una cobertura mínima.", "BodyX")]], colWidths=[172 * mm])
warning.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PALE_AMBER), ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#FDBA74")),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                                  ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
story += [warning, Spacer(1, 7 * mm), p("Conclusión", "H2X"),
          rich("El recálculo demuestra que la evidencia previamente pagada era reutilizable y que el principal defecto estaba en el matching local. El score <b>27/100</b> es una lectura auditiva útil, pero todavía no debe activar una decisión comercial. La siguiente corrección recomendada es exigir cobertura mínima para A1/A3/A6 y consultar únicamente los cuatro nombres pendientes.", "BodyX"),
          p("Archivos utilizados", "H2X"),
          p("output/integrated/gallardolawyers.com-2026-09-15T00-11-26-608Z/raw-bar.json", "TinyX"),
          p("output/integrated/gallardolawyers.com-2026-09-15T00-11-26-608Z/raw-avvo.json", "TinyX"),
          p("output/integrated/gallardolawyers.com-2026-09-15T00-11-26-608Z/raw-website.json", "TinyX"),
          p("output/diag/score-cached-gallardo.json", "TinyX")]

doc.build(story)
print(str(OUT))
