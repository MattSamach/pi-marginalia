# Change maps

A change map shows the modules a plan adds or changes among the ones it leaves alone, and which way their dependencies point.

```mermaid
flowchart TB
  ui["Web UI"]
  subgraph service["Service"]
    api["API (changed)"]
    scorer["Scorer (new)"]
  end
  subgraph data["Data"]
    db[("Database (unchanged)")]
    cache[("Cache (new)")]
  end
  ui --> api
  api --> scorer
  scorer --> db
  scorer --> cache
  class scorer,cache new
  class api changed
```

- Arrows point from a module to what it depends on: calls, reads, and writes. Draw each dependency the plan names, and only those.
- Box modules by layer, the way the system is built — interface, services, data — never by change status. Boxes of "added" and "changed" modules split the layers apart and send most edges across boxes.
- Mark each module's status in its label, `(new)`, `(changed)`, or `(unchanged)`, so the status reads without color, and tag the same modules with the `new`, `changed`, or `removed` role so the palette makes them stand out. Untouched modules stay untagged.
