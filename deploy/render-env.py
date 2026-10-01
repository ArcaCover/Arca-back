"""Render the Compose env file from production.env and the /arca/prod SSM parameters.

Usage: aws ssm get-parameters-by-path ... --output json | render-env.py PRODUCTION_ENV IMAGE

Compose interpolates every value of an env file, so each '$' is written as '$$'. Secrets are
stored raw in Parameter Store, including the bcrypt hash of the docs password, and nobody has
to remember to escape them by hand. Runs on the host's system Python 3.9: standard library only.
"""
import json
import re
import sys

REQUIRED_SECRETS = ("SUPABASE_URL", "SUPABASE_SECRET_KEY", "SESSION_TOKEN_SECRET", "APIFY_API_TOKEN", "DOCS_AUTH_HASH")
BCRYPT = re.compile(r"^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$")
KEY = re.compile(r"^[A-Z][A-Z0-9_]*$")


def fail(message):
    sys.stderr.write(message + "\n")
    sys.exit(4)


def parse_env(path):
    values = {}
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            key, separator, value = line.partition("=")
            if not separator or not KEY.match(key):
                fail(f"{path}:{number} is not KEY=value")
            values[key] = value
    return values


def main():
    if len(sys.argv) != 3:
        fail("usage: render-env.py PRODUCTION_ENV IMAGE")
    settings = parse_env(sys.argv[1])
    secrets = {}
    for parameter in json.load(sys.stdin).get("Parameters", []):
        key = parameter["Name"].rsplit("/", 1)[-1]
        if not KEY.match(key):
            fail(f"Parameter {parameter['Name']} is not named after an environment variable")
        secrets[key] = parameter["Value"]

    required = list(REQUIRED_SECRETS)
    # Every extraction but 'rules' runs on OpenAI, and the API refuses to start without its key;
    # name the missing key here instead of leaving an unhealthy container to explain it.
    if settings.get("WEBSITE_EVIDENCE_PROVIDER", "agentic") != "rules":
        required.append("OPENAI_API_KEY")
    missing = [key for key in required if not secrets.get(key)]
    if missing:
        fail("Missing parameters under /arca/prod: " + ", ".join(missing))
    overlap = sorted(set(secrets) & (set(settings) | {"ARCA_IMAGE"}))
    if overlap:
        fail("Defined both in production.env and in /arca/prod, keep one: " + ", ".join(overlap))
    # An unusable hash reaches Caddy truncated and leaves /docs open, so refuse the deploy instead.
    if not BCRYPT.match(secrets["DOCS_AUTH_HASH"]):
        fail("/arca/prod/DOCS_AUTH_HASH must be the bcrypt hash printed by `caddy hash-password`")

    merged = {"ARCA_IMAGE": sys.argv[2], **settings, **secrets}
    for key, value in merged.items():
        if "\n" in value or "\r" in value:
            fail(f"{key} spans several lines, which an env file cannot hold")
        sys.stdout.write(f"{key}={value.replace('$', '$$')}\n")


if __name__ == "__main__":
    main()
