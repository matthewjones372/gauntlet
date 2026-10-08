# README diagrams

The README embeds these as SVG images, because GitHub's mobile app doesn't
render Mermaid. Edit the `.mmd` source, then regenerate both themes:

```bash
cd docs/diagrams && for n in *.mmd; do n=${n%.mmd}; bunx @mermaid-js/mermaid-cli@11 -i $n.mmd -o $n.light.svg -b transparent -t default -c mermaid.json; bunx @mermaid-js/mermaid-cli@11 -i $n.mmd -o $n.dark.svg -b transparent -t dark -c mermaid.json; done
```

`mermaid.json` turns off HTML labels, so the text is plain SVG that every
viewer can draw.
