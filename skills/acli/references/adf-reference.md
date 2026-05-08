# Atlassian Document Format (ADF) Reference

<!-- AIDEV-NOTE: Comprehensive ADF reference for use with acli commands that accept --description, --body, --description-file, --body-file, and --body-adf flags. All node types and marks from the ADF v1 spec are covered. JSON schema: http://go.atlassian.com/adf-json-schema -->

## Overview

Atlassian Document Format (ADF) is the JSON-based rich text format used by Jira Cloud (and Confluence) for descriptions, comments, and other rich text fields. When you need formatting beyond plain text (headings, lists, tables, code blocks, mentions, etc.), you must provide content as ADF JSON.

**JSON Schema:** <http://go.atlassian.com/adf-json-schema>

### Root Structure

Every ADF document starts with a `doc` node:

```json
{
  "version": 1,
  "type": "doc",
  "content": []
}
```

The `content` array holds block nodes (paragraph, heading, bulletList, table, etc.).

- `version` must be `1`
- `type` must be `"doc"`
- `content` is an array of **block nodes**

### Node Hierarchy

```
doc
 └── block nodes (paragraph, heading, bulletList, table, ...)
      └── inline nodes (text, mention, emoji, status, ...)
           └── marks (strong, em, link, code, ...)
```

---

## Block Nodes

### paragraph

The most basic block. Contains inline nodes.

```json
{
  "type": "paragraph",
  "content": [
    { "type": "text", "text": "Hello world" }
  ]
}
```

### heading

Headings level 1-6, set via `attrs.level`.

```json
{
  "type": "heading",
  "attrs": { "level": 2 },
  "content": [
    { "type": "text", "text": "Section Title" }
  ]
}
```

### bulletList

Unordered list. Children must be `listItem` nodes.

```json
{
  "type": "bulletList",
  "content": [
    {
      "type": "listItem",
      "content": [
        {
          "type": "paragraph",
          "content": [{ "type": "text", "text": "First item" }]
        }
      ]
    },
    {
      "type": "listItem",
      "content": [
        {
          "type": "paragraph",
          "content": [{ "type": "text", "text": "Second item" }]
        }
      ]
    }
  ]
}
```

### orderedList

Numbered list. Optional `attrs.order` sets the starting number (defaults to 1).

```json
{
  "type": "orderedList",
  "attrs": { "order": 1 },
  "content": [
    {
      "type": "listItem",
      "content": [
        {
          "type": "paragraph",
          "content": [{ "type": "text", "text": "Step one" }]
        }
      ]
    },
    {
      "type": "listItem",
      "content": [
        {
          "type": "paragraph",
          "content": [{ "type": "text", "text": "Step two" }]
        }
      ]
    }
  ]
}
```

### codeBlock

Preformatted code. Optional `attrs.language` for syntax highlighting (uses Prism-supported languages: `javascript`, `python`, `bash`, `java`, `typescript`, `json`, `sql`, `yaml`, `go`, `rust`, etc.).

```json
{
  "type": "codeBlock",
  "attrs": { "language": "python" },
  "content": [
    { "type": "text", "text": "def hello():\n    print('Hello world')" }
  ]
}
```

### blockquote

Block quote. Contains other block nodes (typically paragraphs).

```json
{
  "type": "blockquote",
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "This is a quoted passage." }
      ]
    }
  ]
}
```

### table, tableRow, tableCell, tableHeader

Tables with optional configuration.

**Table attrs** (all optional):
- `isNumberColumnEnabled` (boolean) — show row numbers
- `layout` — `"center"` or `"align-start"`
- `width` (number) — fixed width in pixels
- `displayMode` — `"default"` or `"fixed"`

**Cell/Header attrs** (all optional):
- `colspan` (number) — column span
- `rowspan` (number) — row span
- `colwidth` (array of numbers) — column widths in pixels
- `background` (string) — hex color e.g. `"#deebff"`

```json
{
  "type": "table",
  "attrs": { "isNumberColumnEnabled": false, "layout": "center" },
  "content": [
    {
      "type": "tableRow",
      "content": [
        {
          "type": "tableHeader",
          "attrs": {},
          "content": [
            {
              "type": "paragraph",
              "content": [{ "type": "text", "text": "Name" }]
            }
          ]
        },
        {
          "type": "tableHeader",
          "attrs": {},
          "content": [
            {
              "type": "paragraph",
              "content": [{ "type": "text", "text": "Status" }]
            }
          ]
        }
      ]
    },
    {
      "type": "tableRow",
      "content": [
        {
          "type": "tableCell",
          "attrs": {},
          "content": [
            {
              "type": "paragraph",
              "content": [{ "type": "text", "text": "Feature A" }]
            }
          ]
        },
        {
          "type": "tableCell",
          "attrs": {},
          "content": [
            {
              "type": "paragraph",
              "content": [{ "type": "text", "text": "Done" }]
            }
          ]
        }
      ]
    }
  ]
}
```

### panel

Colored information panels. `attrs.panelType` is required.

**Panel types:** `info` (blue), `note` (purple), `warning` (yellow), `success` (green), `error` (red)

```json
{
  "type": "panel",
  "attrs": { "panelType": "warning" },
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "This action cannot be undone." }
      ]
    }
  ]
}
```

### expand

Collapsible/expandable section. `attrs.title` is the visible header text.

```json
{
  "type": "expand",
  "attrs": { "title": "Click to see details" },
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Hidden details go here." }
      ]
    }
  ]
}
```

### nestedExpand

Use inside table cells instead of `expand` (which is not allowed in tables).

```json
{
  "type": "nestedExpand",
  "attrs": { "title": "More info" },
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "Expandable content within a table cell." }
      ]
    }
  ]
}
```

### rule

Horizontal rule (divider). No content or attrs.

```json
{
  "type": "rule"
}
```

### mediaGroup, mediaSingle, media

Media nodes for images, files, and attachments. These require files to be uploaded via the Jira attachment API first — the `id` attr references the uploaded file's ID.

**mediaSingle** — single media item with display options:
```json
{
  "type": "mediaSingle",
  "attrs": { "layout": "center" },
  "content": [
    {
      "type": "media",
      "attrs": {
        "id": "abc-123-def",
        "type": "file",
        "collection": "jira-issue-attachments"
      }
    }
  ]
}
```

**mediaGroup** — multiple media items (file list):
```json
{
  "type": "mediaGroup",
  "content": [
    {
      "type": "media",
      "attrs": {
        "id": "file-id-1",
        "type": "file",
        "collection": "jira-issue-attachments"
      }
    },
    {
      "type": "media",
      "attrs": {
        "id": "file-id-2",
        "type": "file",
        "collection": "jira-issue-attachments"
      }
    }
  ]
}
```

**media attrs:**
- `id` (string, required) — file/attachment ID
- `type` (string, required) — `"file"`, `"link"`, or `"external"`
- `collection` (string) — usually `"jira-issue-attachments"`
- `width` / `height` (number) — dimensions in pixels
- `alt` (string) — alt text for images

---

## Inline Nodes

Inline nodes appear inside block nodes (typically inside `paragraph` or `heading`).

### text

The fundamental inline node. Plain text, optionally with marks for formatting.

```json
{ "type": "text", "text": "Hello world" }
```

With marks (see [Marks](#marks) section):
```json
{
  "type": "text",
  "text": "bold text",
  "marks": [{ "type": "strong" }]
}
```

### mention

User @-mention. Requires the user's Atlassian account ID.

```json
{
  "type": "mention",
  "attrs": {
    "id": "5b10ac8d82e05b22cc7d4ef5",
    "text": "@Jane Smith",
    "accessLevel": ""
  }
}
```

- `id` (string, required) — Atlassian account ID
- `text` (string) — display text (shown if user lookup fails)
- `accessLevel` (string) — `""`, `"CONTAINER"`, `"APPLICATION"`, or `"SITE"`

### emoji

Emoji inline node.

```json
{
  "type": "emoji",
  "attrs": {
    "shortName": ":thumbsup:",
    "id": "1f44d",
    "text": "👍"
  }
}
```

- `shortName` (string, required) — emoji short code (e.g. `:thumbsup:`, `:warning:`, `:white_check_mark:`)
- `id` (string) — Unicode code point or Atlassian emoji ID
- `text` (string) — fallback text representation

### date

Displays a formatted date. Uses a Unix timestamp string (milliseconds since epoch).

```json
{
  "type": "date",
  "attrs": {
    "timestamp": "1700000000000"
  }
}
```

- `timestamp` (string, required) — milliseconds since epoch as a string

### status

Colored status lozenge.

**Colors:** `neutral` (grey), `purple`, `blue`, `red`, `yellow`, `green`

```json
{
  "type": "status",
  "attrs": {
    "text": "In Progress",
    "color": "blue",
    "localId": "unique-id-123",
    "style": ""
  }
}
```

- `text` (string, required) — status label
- `color` (string, required) — one of the colors above
- `localId` (string) — unique identifier
- `style` (string) — typically `""` or `"subtle"`

### inlineCard

Smart link card (renders URL previews inline). Provide either `url` or `data`, not both.

```json
{
  "type": "inlineCard",
  "attrs": {
    "url": "https://mysite.atlassian.net/browse/KEY-123"
  }
}
```

With JSON-LD data instead of URL:
```json
{
  "type": "inlineCard",
  "attrs": {
    "data": {
      "@type": "Document",
      "name": "My Document",
      "url": "https://example.com/doc"
    }
  }
}
```

### hardBreak

Line break within a paragraph (like `<br>`). No attrs or content.

```json
{ "type": "hardBreak" }
```

Example — two lines in one paragraph:
```json
{
  "type": "paragraph",
  "content": [
    { "type": "text", "text": "Line one" },
    { "type": "hardBreak" },
    { "type": "text", "text": "Line two" }
  ]
}
```

---

## Marks

Marks are applied to `text` nodes to add formatting. Multiple marks can be combined on a single text node.

### strong

Bold text.

```json
{
  "type": "text",
  "text": "important",
  "marks": [{ "type": "strong" }]
}
```

### em

Italic text.

```json
{
  "type": "text",
  "text": "emphasized",
  "marks": [{ "type": "em" }]
}
```

### underline

Underlined text.

```json
{
  "type": "text",
  "text": "underlined",
  "marks": [{ "type": "underline" }]
}
```

### strike

Strikethrough text.

```json
{
  "type": "text",
  "text": "deleted",
  "marks": [{ "type": "strike" }]
}
```

### code

Inline code (monospace).

```json
{
  "type": "text",
  "text": "console.log()",
  "marks": [{ "type": "code" }]
}
```

### link

Hyperlink. Applied as a mark with `attrs.href`.

```json
{
  "type": "text",
  "text": "Click here",
  "marks": [
    {
      "type": "link",
      "attrs": {
        "href": "https://example.com",
        "title": "Example Site"
      }
    }
  ]
}
```

- `href` (string, required) — URL
- `title` (string) — tooltip text

### textColor

Colored text. Uses hex color codes.

```json
{
  "type": "text",
  "text": "red warning",
  "marks": [
    {
      "type": "textColor",
      "attrs": { "color": "#ff0000" }
    }
  ]
}
```

### subsup

Subscript or superscript text.

```json
{
  "type": "text",
  "text": "2",
  "marks": [
    {
      "type": "subsup",
      "attrs": { "type": "sub" }
    }
  ]
}
```

- `attrs.type` — `"sub"` (subscript) or `"sup"` (superscript)

### backgroundColor

Highlighted/background-colored text.

```json
{
  "type": "text",
  "text": "highlighted",
  "marks": [
    {
      "type": "backgroundColor",
      "attrs": { "color": "#fff3cd" }
    }
  ]
}
```

---

## Combining Marks

Multiple marks can be applied to the same text node:

### Bold + Italic

```json
{
  "type": "text",
  "text": "bold and italic",
  "marks": [
    { "type": "strong" },
    { "type": "em" }
  ]
}
```

### Bold + Link

```json
{
  "type": "text",
  "text": "important link",
  "marks": [
    { "type": "strong" },
    {
      "type": "link",
      "attrs": { "href": "https://example.com" }
    }
  ]
}
```

### Bold + Colored Text

```json
{
  "type": "text",
  "text": "CRITICAL",
  "marks": [
    { "type": "strong" },
    {
      "type": "textColor",
      "attrs": { "color": "#ff0000" }
    }
  ]
}
```

### Mixed Formatting in a Paragraph

A paragraph with normal, bold, italic, and linked text:

```json
{
  "type": "paragraph",
  "content": [
    { "type": "text", "text": "This is " },
    {
      "type": "text",
      "text": "bold",
      "marks": [{ "type": "strong" }]
    },
    { "type": "text", "text": " and " },
    {
      "type": "text",
      "text": "italic",
      "marks": [{ "type": "em" }]
    },
    { "type": "text", "text": " with a " },
    {
      "type": "text",
      "text": "link",
      "marks": [
        {
          "type": "link",
          "attrs": { "href": "https://example.com" }
        }
      ]
    },
    { "type": "text", "text": "." }
  ]
}
```

---

## Shell Helper Snippets

These bash functions generate ADF JSON for common patterns. Use them to build ADF content for `--description-file`, `--body-file`, or `--body-adf`.

<!-- AIDEV-NOTE: These helper functions output ADF JSON fragments or complete documents. They use printf for safe escaping. The adf_doc() function wraps content fragments into a complete ADF document. -->

### adf_text — Plain text node (with optional mark)

```bash
# Usage: adf_text "text" ["mark_type"]
# Example: adf_text "hello"
# Example: adf_text "bold text" "strong"
adf_text() {
  local text="$1" mark="$2"
  # Escape JSON special chars in text
  text=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\n/\\n/g')
  if [ -n "$mark" ]; then
    printf '{"type":"text","text":"%s","marks":[{"type":"%s"}]}' "$text" "$mark"
  else
    printf '{"type":"text","text":"%s"}' "$text"
  fi
}
```

### adf_paragraph — Paragraph with plain text

```bash
# Usage: adf_paragraph "text"
adf_paragraph() {
  local text="$1"
  text=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\n/\\n/g')
  printf '{"type":"paragraph","content":[{"type":"text","text":"%s"}]}' "$text"
}
```

### adf_heading — Heading node

```bash
# Usage: adf_heading level "text"
# Example: adf_heading 2 "Section Title"
adf_heading() {
  local level="$1" text="$2"
  text=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\n/\\n/g')
  printf '{"type":"heading","attrs":{"level":%d},"content":[{"type":"text","text":"%s"}]}' "$level" "$text"
}
```

### adf_code_block — Code block with language

```bash
# Usage: adf_code_block "language" "code"
# Example: adf_code_block "bash" "echo hello"
adf_code_block() {
  local lang="$1" code="$2"
  code=$(printf '%s' "$code" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')
  # Preserve actual newlines as \n in JSON
  code=$(printf '%s' "$code" | awk '{printf "%s\\n", $0}' | sed 's/\\n$//')
  printf '{"type":"codeBlock","attrs":{"language":"%s"},"content":[{"type":"text","text":"%s"}]}' "$lang" "$code"
}
```

### adf_bullet_list — Bullet list from arguments

```bash
# Usage: adf_bullet_list "item1" "item2" "item3"
adf_bullet_list() {
  local items=""
  for item in "$@"; do
    item=$(printf '%s' "$item" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\n/\\n/g')
    [ -n "$items" ] && items="$items,"
    items="$items{\"type\":\"listItem\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"$item\"}]}]}"
  done
  printf '{"type":"bulletList","content":[%s]}' "$items"
}
```

### adf_panel — Panel with type and text

```bash
# Usage: adf_panel "panelType" "text"
# Example: adf_panel "warning" "This is irreversible!"
adf_panel() {
  local panel_type="$1" text="$2"
  text=$(printf '%s' "$text" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\n/\\n/g')
  printf '{"type":"panel","attrs":{"panelType":"%s"},"content":[{"type":"paragraph","content":[{"type":"text","text":"%s"}]}]}' "$panel_type" "$text"
}
```

### adf_status — Status lozenge

```bash
# Usage: adf_status "text" "color"
# Example: adf_status "Done" "green"
adf_status() {
  local text="$1" color="$2"
  printf '{"type":"status","attrs":{"text":"%s","color":"%s","localId":"","style":""}}' "$text" "$color"
}
```

### adf_doc — Wrap content fragments into a complete ADF document

```bash
# Usage: adf_doc "content1" "content2" ...
# Each argument is a JSON fragment from the helpers above.
adf_doc() {
  local content=""
  for fragment in "$@"; do
    [ -n "$content" ] && content="$content,"
    content="$content$fragment"
  done
  printf '{"version":1,"type":"doc","content":[%s]}' "$content"
}
```

### Complete Example — Rich Description

Building a work item description with heading, paragraph, bullet list, warning panel, and code block:

```bash
# Build individual ADF fragments
h=$(adf_heading 3 "Implementation Plan")
p=$(adf_paragraph "This feature requires the following changes:")
bl=$(adf_bullet_list "Update the API endpoint" "Add input validation" "Write integration tests")
warn=$(adf_panel "warning" "This changes the public API contract — coordinate with consumers.")
cb=$(adf_code_block "typescript" "export async function updateUser(id: string, data: UserInput) {\n  const validated = schema.parse(data)\n  return db.users.update({ where: { id }, data: validated })\n}")

# Combine into a complete ADF document and write to file
adf_doc "$h" "$p" "$bl" "$warn" "$cb" > /tmp/description.json

# Use with acli
acli jira workitem create \
  --summary "Implement user update endpoint" \
  --project "TEAM" \
  --type "Story" \
  --description-file /tmp/description.json

# Clean up
rm -f /tmp/description.json
```

### Complete Example — Rich Comment

```bash
# Build a comment with status lozenge, bold text, and a link
status_p=$(printf '{"type":"paragraph","content":[{"type":"text","text":"Status: "},{"type":"status","attrs":{"text":"In Review","color":"blue","localId":"","style":""}},{"type":"text","text":" — ready for "},{"type":"text","text":"code review","marks":[{"type":"strong"}]}]}')
link_p=$(printf '{"type":"paragraph","content":[{"type":"text","text":"PR: "},{"type":"text","text":"#456 - Add validation","marks":[{"type":"link","attrs":{"href":"https://github.com/org/repo/pull/456"}}]}]}')

adf_doc "$status_p" "$link_p" > /tmp/comment.json

acli jira workitem comment create \
  --key "KEY-123" \
  --body-file /tmp/comment.json

rm -f /tmp/comment.json
```
