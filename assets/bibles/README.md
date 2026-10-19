# Bibles

Bible files the assistant reads verses from. Drop a file here, then:

```bash
bun scripts/import-bible.ts assets/bibles/<file> --check   # verify
bun scripts/import-bible.ts assets/bibles/<file>           # import to dev (add --prod for production)
```

**This repository is public. Only public-domain translations belong here**
(KJV, ASV, YLT, WEB, BSB, Darby). Copyrighted ones (NIV, ESV, NKJV, NLT, AMP,
NASB, CSB) go in `assets/bibles/private/`, which is gitignored — import them
from your machine.

| File | Translation | Source | Status |
|---|---|---|---|
| `KJV.json` | Authorized King James Version (1769) | Bible SuperSearch export | public domain (Crown copyright in the UK only) |

Formats, download links and everything else: [`docs/SCRIPTURE.md`](../../docs/SCRIPTURE.md).
