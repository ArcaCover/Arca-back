import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Flowable, Frame, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle

ROOT = Path(r"C:\Users\jesus\projects\Arca-back")
DATA = ROOT / "output/diag/score-cached-duque.json"
OUT = ROOT / "output/pdf/resultados-score-cache-apify-duque.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(DATA.read_text(encoding="utf-8-sig"))
original, cached, sources, signals = data["original"], data["cached"], data["sources"], data["signals"]

fonts = Path(r"C:\Windows\Fonts")
pdfmetrics.registerFont(TTFont("Arial", str(fonts / "arial.ttf")))
pdfmetrics.registerFont(TTFont("Arial-Bold", str(fonts / "arialbd.ttf")))

NAVY = colors.HexColor("#102A43")
BLUE = colors.HexColor("#2563EB")
GREEN = colors.HexColor("#15803D")
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
styles.add(ParagraphStyle(name="TinyX", fontName="Arial", fontSize=6.7, leading=8.8, textColor=INK))
styles.add(ParagraphStyle(name="TinyBoldX", fontName="Arial-Bold", fontSize=6.7, leading=8.8, textColor=INK))
styles.add(ParagraphStyle(name="HeaderX", fontName="Arial-Bold", fontSize=6.7, leading=8.8, textColor=colors.white))
styles.add(ParagraphStyle(name="KpiX", fontName="Arial-Bold", fontSize=17, leading=19, textColor=NAVY, alignment=TA_CENTER))
styles.add(ParagraphStyle(name="KpiLabelX", fontName="Arial", fontSize=7.3, leading=9.2, textColor=MUTED, alignment=TA_CENTER))


def esc(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def p(value, style="BodyX"):
    return Paragraph(esc(value), styles[style])


def rich(value, style="BodyX"):
    return Paragraph(value, styles[style])


class ScoreBar(Flowable):
    def __init__(self, score, maximum, width=34 * mm, color=BLUE):
        super().__init__(); self.score = score; self.maximum = maximum; self.width = width; self.height = 7 * mm; self.color = color
    def draw(self):
        c = self.canv; c.setFillColor(colors.HexColor("#E6EDF5")); c.roundRect(0, 0, self.width, self.height, 2 * mm, fill=1, stroke=0)
        fill = self.width * max(0, min(self.score / self.maximum if self.maximum else 0, 1))
        if fill: c.setFillColor(self.color); c.roundRect(0, 0, fill, self.height, 2 * mm, fill=1, stroke=0)
        c.setFillColor(INK); c.setFont("Arial-Bold", 7.4); c.drawCentredString(self.width / 2, 2.05 * mm, f"{self.score}/{self.maximum}")


def header_footer(canvas, doc):
    canvas.saveState(); width, _ = A4; canvas.setStrokeColor(LINE); canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 15 * mm, width - 18 * mm, 15 * mm); canvas.setFont("Arial", 7); canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 9.5 * mm, "Arca — recuperación de evidencia Apify de Duque")
    canvas.drawRightString(width - 18 * mm, 9.5 * mm, f"Página {doc.page}"); canvas.restoreState()


def table(rows, widths, header=True):
    if header:
        rows = [[Paragraph(esc(cell.getPlainText() if isinstance(cell, Paragraph) else cell), styles["HeaderX"]) for cell in rows[0]], *rows[1:]]
    result = Table(rows, colWidths=widths, repeatRows=1 if header else 0, splitByRow=1)
    commands = [("GRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [colors.white, PALE])]
    if header: commands += [("BACKGROUND", (0, 0), (-1, 0), NAVY)]
    result.setStyle(TableStyle(commands)); return result


doc = BaseDocTemplate(str(OUT), pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm, topMargin=18 * mm, bottomMargin=19 * mm,
                      title="Score con evidencia Apify recuperada — Duque Immigration Law", author="Arca / Codex")
frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="normal")
doc.addPageTemplates([PageTemplate(id="main", frames=frame, onPage=header_footer)])

story = [Spacer(1, 8 * mm), rich("REPORTE DE RECUPERACIÓN", "SmallX"), p("Score con evidencia Apify recuperada", "TitleX"),
         p("Duque Immigration Law, PLLC | datasets de runs existentes | 17 de septiembre de 2026", "SubtitleX")]

kpis = [[p("SCORE", "KpiLabelX"), p("AVVO", "KpiLabelX"), p("FLORIDA BAR", "KpiLabelX")],
        [p("43/100", "KpiX"), p("1/1", "KpiX"), p("1/1", "KpiX")],
        [p("antes: 6/100", "KpiLabelX"), p("Carlos Duque recuperado", "KpiLabelX"), p("Carlos Duque verificado", "KpiLabelX")]]
kt = Table(kpis, colWidths=[57.3 * mm] * 3, rowHeights=[8 * mm, 12 * mm, 9 * mm])
kt.setStyle(TableStyle([("BACKGROUND", (0, 0), (0, -1), PALE_BLUE), ("BACKGROUND", (1, 0), (1, -1), PALE_GREEN),
                        ("BACKGROUND", (2, 0), (2, -1), PALE_AMBER), ("BOX", (0, 0), (-1, -1), 0.6, LINE),
                        ("INNERGRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
story += [kt, Spacer(1, 8 * mm), p("Resultado ejecutivo", "H1X"),
          rich("El run de Avvo había terminado en timeout, pero su dataset seguía retenido con <b>29 filas</b>. Entre ellas aparece <b>Carlos Mauricio Duque</b>, con nombre exacto y el mismo teléfono de la firma. Una nueva consulta, limitada exclusivamente a Carlos, también recuperó su perfil oficial de Florida Bar. El score sube de <b>6 a 43</b>.", "BodyX")]

callout = Table([[rich("<b>Resultado:</b> tier EXPOSED, decisión UNKNOWN y assessment INSUFFICIENT_EVIDENCE. La licencia de Carlos queda verificada; la decisión continúa bloqueada por disciplina histórica incompleta y señales web desconocidas.", "BodyX")]], colWidths=[172 * mm])
callout.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PALE_AMBER), ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#FDBA74")),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                                  ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
story += [callout, Spacer(1, 6 * mm), p("Comparación por categoría", "H2X")]

labels = {"aiGovernance": "Gobierno de IA", "professionalStanding": "Situación profesional", "reputation": "Reputación", "firmMaturity": "Madurez de la firma"}
rows = [[p("Categoría", "TinyBoldX"), p("Original", "TinyBoldX"), p("Recuperado", "TinyBoldX"), p("Cambio", "TinyBoldX"), p("Estado", "TinyBoldX")]]
for key, label in labels.items():
    old, new = original["categories"][key], cached["categories"][key]; delta = new["score"] - old["score"]
    rows.append([p(label, "SmallX"), ScoreBar(old["score"], old["max"], color=MUTED), ScoreBar(new["score"], new["max"], color=GREEN if delta else BLUE),
                 p(f"{delta:+d}", "SmallX"), p(new["status"], "SmallX")])
story += [table(rows, [37 * mm, 36 * mm, 36 * mm, 20 * mm, 43 * mm]), Spacer(1, 6 * mm), p("Costo", "H2X"),
          rich("Costo histórico reconciliado del run Avvo: <b>USD 1.23975</b>. El resultado original había registrado USD 0.89775 antes de que el run terminara de contabilizar consumo. Recuperar ese dataset costó <b>USD 0</b>; la nueva consulta única de Florida Bar también reportó <b>USD 0</b>.", "BodyX"), PageBreak()]

story += [p("Evidencia y reglas", "H1X"), Spacer(1, 2 * mm), p("Carlos Mauricio Duque", "H2X")]
profile = [[p("Fuente", "TinyBoldX"), p("Evidencia", "TinyBoldX"), p("Uso en scoring", "TinyBoldX")],
           [p("Florida Bar", "SmallX"), p("#35614; Member in Good Standing; elegible en Florida; admitido 19/04/2007", "SmallX"), p("B1=+12, B3=+5, B4=+3", "SmallX")],
           [p("Florida Bar", "SmallX"), p("Duque Immigration Law; mismo teléfono, dirección y email corporativo", "SmallX"), p("Identidad exacta y contexto verificado", "SmallX")],
           [p("Avvo", "SmallX"), p("Rating 9.0 Superb; 44 reseñas, promedio 5.0; sin premios", "SmallX"), p("A1=+9, A3=+5, A6=0", "SmallX")],
           [p("Sitio + Avvo", "SmallX"), p("Área Immigration", "SmallX"), p("W9_A2=+3", "SmallX")]]
story += [table(profile, [38 * mm, 82 * mm, 52 * mm]), Spacer(1, 6 * mm), p("Composición profesional de la firma", "H2X")]

roster = [[p("Persona", "TinyBoldX"), p("Rol publicado", "TinyBoldX"), p("Jurisdicción y tratamiento", "TinyBoldX")],
          [p("Carlos Mauricio Duque", "SmallX"), p("Immigration Attorney", "SmallX"), p("Licenciado en Florida y Colombia; único abogado incluido en Bar y Avvo.", "SmallX")],
          [p("Melina Ocampo", "SmallX"), p("Humanitarian Relief Case Manager", "SmallX"), p("Licenciada para ejercer únicamente en Colombia; excluida de directorios de Florida.", "SmallX")],
          [p("Diana Posada", "SmallX"), p("Immigration Paralegal", "SmallX"), p("Licenciada para ejercer únicamente en Colombia; excluida de directorios de Florida.", "SmallX")]]
story += [table(roster, [42 * mm, 55 * mm, 75 * mm]), Spacer(1, 6 * mm),
          p("El roster sujeto a scoring estadounidense contiene un solo abogado. El equipo legal ampliado contiene tres profesionales con formación jurídica, pero las dos abogadas colombianas no se consideran ausencias de Florida Bar ni Avvo.", "SmallX"),
          p("Detalle de categorías", "H2X")]

detail = [[p("Categoría", "TinyBoldX"), p("Score", "TinyBoldX"), p("Explicación", "TinyBoldX")],
          [p("Gobierno de IA", "SmallX"), p("0/35 · UNKNOWN", "SmallX"), p("W1–W4 permanecen sin evidencia.", "SmallX")],
          [p("Situación profesional", "SmallX"), p("20/30 · PARTIAL", "SmallX"), p("Carlos está activo (+12), consistencia 1.0 (+5) y experiencia 19.4 años (+3). La disciplina histórica completa sigue desconocida.", "SmallX")],
          [p("Reputación", "SmallX"), p("14/20 · KNOWN", "SmallX"), p("A1=+9, A3=+5 y A6=0 desde el perfil Avvo exacto.", "SmallX")],
          [p("Madurez", "SmallX"), p("9/15 · PARTIAL", "SmallX"), p("Sitio robusto +3, equipo detallado +3 y coherencia de Immigration +3.", "SmallX")]]
story += [table(detail, [45 * mm, 37 * mm, 90 * mm]), Spacer(1, 7 * mm), p("Multiplicadores observados", "H2X"),
          p("Área: Immigration, valor 1.8. Jurisdicción: Florida, valor 1.25. Tamaño sujeto a scoring estadounidense: 1 abogado, valor 0.9."), PageBreak()]

story += [p("Recuperación, límites y decisión", "H1X"), Spacer(1, 2 * mm), p("Runs existentes", "H2X")]
runs = [data["currentBarRun"], next(run for run in data["recoveredRuns"] if run["source"] == "avvo")]
run_rows = [[p("Fuente", "TinyBoldX"), p("Run", "TinyBoldX"), p("Estado", "TinyBoldX"), p("Dataset", "TinyBoldX"), p("Filas / costo", "TinyBoldX")]]
for run in runs:
    run_rows.append([p(run["source"].upper(), "SmallX"), p(run["runId"], "SmallX"), p(run["status"], "SmallX"), p(run["datasetId"], "TinyX"),
                     p(f"{run['itemCount']} / USD {run['usageTotalUsd']:.5f}", "SmallX")])
story += [table(run_rows, [24 * mm, 39 * mm, 31 * mm, 46 * mm, 32 * mm]), Spacer(1, 7 * mm),
          p("Por qué sigue bloqueado", "H2X")]

flags = [[p("Bandera", "TinyBoldX"), p("Causa", "TinyBoldX")],
         [p("INCOMPLETE_SOURCES", "SmallX"), p("Avvo terminó TIMED-OUT y el lote recuperado excede el límite nominal actual.", "SmallX")],
         [p("PARTIAL_ATTORNEY_DATA", "SmallX"), p("El Bar solo establece que no hubo disciplina en diez años; no demuestra un historial vitalicio limpio.", "SmallX")],
         [p("INCOMPLETE_EVIDENCE", "SmallX"), p("IA, privacidad, fundación y disciplina histórica siguen incompletas.", "SmallX")],
         [p("COMMERCIAL_DECISION_BLOCKED", "SmallX"), p("El contrato conserva decision=UNKNOWN hasta completar la evidencia.", "SmallX")]]
story += [table(flags, [65 * mm, 107 * mm]), Spacer(1, 7 * mm)]

warning = Table([[rich("<b>Conclusión:</b> Carlos es el único abogado de la firma que debe consultarse en directorios estadounidenses y quedó validado en ambas fuentes. Melina Ocampo y Diana Posada están licenciadas únicamente en Colombia y no son falsos negativos. El timeout de Avvo ocurrió dentro de la única búsqueda de Carlos: produjo 29 filas antes de finalizar, incluido su perfil correcto.", "BodyX")]], colWidths=[172 * mm])
warning.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PALE_GREEN), ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor("#86EFAC")),
                                  ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                                  ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
story += [warning, Spacer(1, 7 * mm), p("Archivos de auditoría", "H2X"),
          p("output/diag/duque-remote-cache-recovery.json", "TinyX"), p("output/diag/score-cached-duque.json", "TinyX"),
          p("output/diag/duque-bar-rerun.json", "TinyX"),
          p("output/integrated/duqueimmigration.com-2026-09-14T22-25-53-960Z/raw-website.json", "TinyX")]

doc.build(story)
print(str(OUT))
