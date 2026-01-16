---
atlcli:
  id: "642809861"
  title: "export feature test suite"
---

# Export Feature Test Suite

This page contains all formatting and macros for DOCX export testing. Use this page to compare atlcli export with Scroll Word Exporter.

:::toc
:::

## 1. Basic Formatting

### Text Styles

**Bold text** and *italic text* and ***bold italic***

~~Strikethrough text~~

`inline code`

### Lists

Bullet list:

- Bullet item 1
- Bullet item 2
  - Nested bullet A
  - Nested bullet B
- Bullet item 3

Numbered list:

1. Numbered item 1
2. Numbered item 2
   1. Nested numbered A
   2. Nested numbered B
3. Numbered item 3

### Blockquote

> This is a blockquote with important information.
> It can span multiple lines.

---

## 2. Tables

| Column A | Column B | Column C |
|----------|----------|----------|
| Cell 1   | Cell 2   | Cell 3   |
| Cell 4   | Cell 5   | Cell 6   |
| **Bold** | *Italic* | `Code`   |

## 3. Code Blocks

### Fenced Code Block

```python
def hello():
    print("Hello, World!")
    return True
```

### Code with Language

```javascript
function greet(name) {
    console.log(`Hello, ${name}!`);
}
```

## 4. Links

- [External link to Google](https://www.google.com)
- [Link to Atlassian](https://www.atlassian.com)

## 5. Images

![Test Image](./export-feature-test-suite.attachments/test-image.jpg)

## 6. Panel Macros

:::info Information Panel
This is an info panel with a title. It contains important information for the reader.
:::

:::info
Info panel without a title - just content.
:::

:::warning Caution Required
This is a warning panel - pay attention to this content!
:::

:::note Remember This
This is a note panel for additional context and reminders.
:::

:::tip Pro Tip
This is a tip panel with helpful advice for users.
:::

## 7. Status Badges

Project Status: {status:green}DONE{status}

Review Status: {status:yellow}IN PROGRESS{status}

Blocker: {status:red}BLOCKED{status}

Info Badge: {status:blue}INFO{status}

Unknown: {status:grey}UNKNOWN{status}

## 8. Expand/Collapse

:::expand Click to see more details
This content is hidden by default and expands when clicked.

- Hidden item 1
- Hidden item 2
- Hidden item 3

Some additional hidden text.
:::

## 9. Table of Contents

:::toc
:::

## 10. Excerpt Macros

:::excerpt name="test-summary"
This is a reusable excerpt that can be included in other pages. It demonstrates the excerpt macro functionality.
:::

:::excerpt name="internal-notes" hidden
This hidden excerpt won't display on the page but can be included elsewhere.
:::

## 11. Task Lists

- [ ] Incomplete task one
- [x] Completed task
- [ ] Another incomplete task
- [x] Another completed task

## 12. Jira Integration

Single issue: {jira:ATLCLI-1}

With summary: {jira:ATLCLI-1|showSummary}

## 13. Anchors

{anchor:test-anchor}

This section has an anchor named "test-anchor" for linking.

## 14. Emoticons

Happy: :) Sad: :( Laugh: :D Wink: ;)

Thumbs up: (y) Thumbs down: (n)

Info: (i) Warning: (!) Question: (?)

Check: (/) Cross: (x) Star: (*)

## 15. Dynamic Macros

### Children Macro

:::children depth=1
:::

### Content by Label

:::content-by-label labels="documentation" max=3
:::

## 16. Page Properties

:::page-properties id="test-metadata"
| Property | Value |
|----------|-------|
| Status   | Active |
| Owner    | Test Team |
| Version  | 1.0 |
:::

---

*End of Export Feature Test Suite*
