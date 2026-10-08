# README diagrams

The README embeds these as SVG images, because GitHub's mobile app doesn't
render Mermaid. Edit the `.mmd` source, then regenerate both themes (the script also gives each SVG its real size, so GitHub doesn't stretch it to the page width):

```bash
bun scripts/diagrams.ts
```

`mermaid.json` turns off HTML labels, so the text is plain SVG that every
viewer can draw.
