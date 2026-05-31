---
name: db-to-ontology
description: >
  Generate a formal ontology from a database schema. Use this skill whenever a user
  wants to create an ontology, knowledge graph, or semantic model from an existing
  database — whether PostgreSQL, MySQL, SQLite, or other SQL databases. Triggers on
  phrases like "build an ontology from my DB", "generate an ontology from my schema",
  "turn my database into an ontology", "create a knowledge graph from my tables",
  or "I have a database and need an ontology". Also triggers when the user shares
  DB connection strings, SQL schema dumps, or CREATE TABLE statements and asks for
  semantic modelling. Always use this skill — do not attempt ontology generation
  without it.
---

# DB → Ontology Skill

Introspect a database schema and produce a formal ontology in Turtle/OWL format,
treated as source code: plain text, version-control ready, compilable by a reasoner.

---

## Step 0 — Gather Connection Info

Ask the user for **one** of:

| Option | What to ask for |
|--------|----------------|
| **A** | Connection string e.g. `postgresql://user:pass@host:5432/dbname` |
| **B** | Raw SQL schema dump (output of `pg_dump --schema-only` or equivalent) |
| **C** | Paste of `CREATE TABLE` statements |

Also ask:
- **Target format**: Turtle (`.ttl`) — default and recommended — or OWL/XML?
- **Base URI**: e.g. `https://example.org/ontology/` (default: `https://org.example/onto/`)
- **Scope**: All tables, or specific ones?

---

## Step 1 — Introspect the Schema

### If live DB connection (Option A):

Run the appropriate introspection query for the DB engine.

**PostgreSQL:**
```bash
pip install psycopg2-binary sqlalchemy --break-system-packages -q

python3 - <<'PYEOF'
import json, sys
from sqlalchemy import create_engine, inspect, text

conn_str = "REPLACE_WITH_CONN_STRING"
engine = create_engine(conn_str)
insp = inspect(engine)

schema = {}
for table in insp.get_table_names():
    schema[table] = {
        "columns": insp.get_columns(table),
        "pk": insp.get_pk_constraint(table),
        "fks": insp.get_foreign_keys(table),
        "indexes": insp.get_indexes(table),
        "unique": insp.get_unique_constraints(table),
    }
    # Coerce types to strings for JSON serialisation
    for col in schema[table]["columns"]:
        col["type"] = str(col["type"])

print(json.dumps(schema, indent=2, default=str))
PYEOF
```

**SQLite:**
```bash
python3 - <<'PYEOF'
import sqlite3, json
conn = sqlite3.connect("PATH_TO_FILE")
cur = conn.cursor()
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in cur.fetchall()]
schema = {}
for t in tables:
    cur.execute(f"PRAGMA table_info({t})")
    cols = cur.fetchall()
    cur.execute(f"PRAGMA foreign_key_list({t})")
    fks = cur.fetchall()
    schema[t] = {"columns": cols, "fks": fks}
print(json.dumps(schema, indent=2))
PYEOF
```

Save the output as `schema.json` in the working directory.

### If schema dump / CREATE TABLE (Options B & C):

Parse the SQL text to extract:
- Table names → candidate **Classes**
- Columns + types → candidate **Data Properties**
- Foreign keys → candidate **Object Properties** (relationships)
- NOT NULL / UNIQUE / CHECK constraints → candidate **Axioms**
- Junction/bridge tables (two FKs, no payload columns) → **many-to-many Object Properties**

Write this as `schema.json` manually before proceeding.

---

## Step 2 — Reason About the Schema (AI Agent Pass)

Call the Anthropic API with the schema JSON and the prompt below. This is the semantic
lifting step — mapping raw DB structure to ontological concepts.

```javascript
const schema = /* load schema.json */;

const prompt = `
You are an ontology engineer. Given this database schema (as JSON), produce a formal
ontology in Turtle (TTL) format.

Rules:
1. Each table → an owl:Class (use PascalCase, singularise: "orders" → "Order")
2. Each column → a data property (xsd: types) OR an object property if it's a FK
3. Foreign keys → owl:ObjectProperty with domain and range
4. Junction tables (two FKs only) → bidirectional owl:ObjectProperty, no class
5. NOT NULL columns → owl:someValuesFrom restriction (mandatory property)
6. UNIQUE columns → owl:FunctionalProperty
7. Infer inverse properties where obvious (e.g. hasOrder ↔ isOrderOf)
8. Add rdfs:label and rdfs:comment for every class and property
9. Use base URI: ${BASE_URI}
10. Include standard prefixes: rdf, rdfs, owl, xsd

Output ONLY valid Turtle. No markdown, no explanation, no backticks.

Schema:
${JSON.stringify(schema, null, 2)}
`;

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }]
  })
});
const data = await response.json();
const turtle = data.content.find(b => b.type === "text")?.text ?? "";
```

Save the result as `ontology.ttl`.

---

## Step 3 — Validate (Compile)

Ontologies should be validated like code. Run a syntax check:

```bash
pip install rdflib --break-system-packages -q

python3 - <<'PYEOF'
from rdflib import Graph
import sys

g = Graph()
try:
    g.parse("ontology.ttl", format="turtle")
    print(f"✅ Valid Turtle — {len(g)} triples loaded")
    
    # Report classes and properties found
    classes = list(g.subjects(predicate=g.namespace_manager.expand_curie("rdf:type"),
                               object=g.namespace_manager.expand_curie("owl:Class")))
    print(f"   Classes: {len(classes)}")
except Exception as e:
    print(f"❌ Parse error: {e}")
    sys.exit(1)
PYEOF
```

If validation fails:
- Feed the error back to the API with the broken TTL and ask it to fix
- Retry up to 3 times
- If still failing, show the user the error and the raw TTL for manual inspection

---

## Step 4 — Generate Supporting Files

### 4a. Human-readable summary (`ontology-summary.md`)

```markdown
# Ontology Summary

**Base URI:** <base_uri>
**Generated from:** <db_name> on <date>
**Triples:** <count>

## Classes
| Class | Label | Source Table |
|-------|-------|-------------|
...

## Object Properties (Relationships)
| Property | Domain | Range | Source FK |
|----------|--------|-------|-----------|
...

## Data Properties
| Property | Domain | XSD Type | Mandatory? |
|----------|--------|----------|------------|
...

## Axioms
- ...
```

### 4b. Build check script (`check.sh`)

```bash
#!/usr/bin/env bash
# Run this in CI to validate the ontology
set -e
python3 -c "
from rdflib import Graph
g = Graph()
g.parse('ontology.ttl', format='turtle')
print(f'✅ {len(g)} triples — ontology is valid')
"
echo "All checks passed."
```

### 4c. `.gitignore`

```
schema.json
*.pyc
__pycache__/
```

---

## Step 5 — Present Outputs

Deliver to the user:
1. `ontology.ttl` — the ontology source (plain text, version-control ready)
2. `ontology-summary.md` — human-readable overview
3. `check.sh` — the "compile" script for CI

Tell the user:
- How to put this in a git repo and run `check.sh` in CI
- That they can open `ontology.ttl` in Protégé for visual exploration
- That LLMs can read and edit `ontology.ttl` directly as source code

---

## Edge Cases & Notes

| Situation | Handling |
|-----------|----------|
| Junction/bridge table (2 FKs only) | Collapse into owl:ObjectProperty — no class |
| Polymorphic FKs (`*_type`, `*_id`) | Flag to user; model as union or separate properties |
| Timestamp/audit columns (created_at, updated_at) | Omit or add to a common AuditableMixin class |
| Many nullable columns | Treat as optional properties (no restriction) |
| Very large schemas (50+ tables) | Process in batches of 20 tables, merge TTL files |
| Column names that are SQL keywords | Sanitise before using as property names |
| No foreign keys defined | Ask user to describe relationships verbally; add to prompt |

---

## References

- See `references/turtle-primer.md` for Turtle syntax examples
- See `references/owl-patterns.md` for common OWL axiom patterns
