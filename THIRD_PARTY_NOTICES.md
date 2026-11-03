# Third-party notices

## dsh-edge 0.30.0 / DeepSeek Harness 0.2.1-rc.2

The personal cloud platform uses the MIT-licensed original runtime from
https://github.com/pawaca/dsh-edge and https://github.com/deepseek-ai/deepseek-harness.
The novel workspace adds version-bound presentation composition seams to the
original conversation and sidebar modules; original model, session, input,
streaming and VFS engines are retained. The pinned originals are not modified
in node_modules. Generated presentation modules retain the upstream notices
and the full MIT license, with Copyright (c) 2026 pawaca and
Copyright (c) 2026 DeepSeek. The installed package's full component inventory
and licenses are in `cloud/tools/node_modules/dsh-edge/THIRD_PARTY_NOTICES.md`.

## CodeMirror 6

Prose editing uses the MIT-licensed CodeMirror state 6.7.6, view 6.43.15 and
commands 6.11.1 packages from https://github.com/codemirror. Exact transitive
versions are in `cloud/tools/package-lock.json`. The generated
`cloud/pages/public/novel-assets/editor-vendor.mjs` includes all dependency MIT
notices. Regenerate with `scripts/run-guarded-task.ps1 -Task cloud-editor-vendor`.

## node-diff3 3.2.1

Three-way text merging uses https://github.com/bhousel/node-diff3 (MIT).
The pinned npm dependency is in `cloud/tools/package-lock.json`. The generated
`cloud/pages/public/novel-assets/diff3-vendor.mjs` includes its full MIT notice,
including the Tony Garnock-Jones / LShift / Bryan Housel copyright notices.
Regenerate using `scripts/run-guarded-task.ps1 -Task cloud-merge-vendor`.

## Design reference: nanbo0ne/novel-writer-v3-99-3

Behavioral reference: https://github.com/nanbo0ne/novel-writer-v3-99-3
Inspected `index.html` at commit `72584b9ccf084d62570707e0992e649bbfee7d7c`
(UTF-8 source SHA-256 `dc15c26914e87329f4997318ca337742f30b2fae8d0b2f7c3cb115b71af5f46c`).
The repository displayed no explicit license at inspection. No source code,
prompts, styles, icons or other assets from it were copied or bundled.
Chapter-target comparison, focused editorial review and readable manuscript
export were independently implemented using this project's original native
conversation, chapter catalog and VFS. Keyword/marker-based completion,
automatic full-memory replacement and automatic prose overwrites were not adopted.

## fast-json-patch 3.1.1

Used for validated JSON Patch application. Source: https://github.com/Starcounter-Jack/JSON-Patch

The MIT License

Copyright (c) 2013, 2014, 2020 Joachim Wester

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# dsh-purge novel adapter

Prompt envelope normalization in `cloud/worker/purge-plugin.mjs` is adapted from
`lib/identity.js` in [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge),
version 1.1.82, commit `0c933dc7d3252698f3f0f9756932dcc88355f532`.
Copyright 2026 YuJunZhiXue. Apache-2.0. Original LICENSE and NOTICE are preserved
under `cloud/pages/public/legal/dsh-purge/`. The host adapter, settings UI and
novel-specific default prompt are local modifications, not the original full
plugin or default prompt. Original host patches and red-team components are not
distributed as active runtime modules.

## Native official-host composition (default anonymous edition)

`cloud/official/package-lock.json` pins official DeepSeek Harness 0.2.1-rc.2
(MIT), original dsh-purge 1.1.82 at the commit above (Apache-2.0),
`@cloudflare/computer` 0.3.1 (package-declared MIT), and its `just-bash` 3.6.0
dependency. Existing upstream package notices are retained in that private
installation. The local compatibility patches alter only this isolated official
host, not the dsh-edge package used to build presentation resources above.

`cloud/scripts/prepare-official-novel.mjs` produces a private Node-compatible
SQLite VFS bundle from Computer's original provider, filesystem facade and
marked shell-adapter region; it excludes Workers RPC/transport code. The
adapter implementation is not replaced with an independent filesystem.
Generated copies are confined to each deployment's runtime directory; the Git
repository distributes source and locked dependencies. Computer's complete MIT
notice is in `cloud/legal/COMPUTER-LICENSE.txt` (the npm package omits LICENSE).
Its source is https://github.com/cloudflare/computer/blob/main/LICENSE.
The public build preserves generated inline notices. Upstream dependencies and
their license files remain in their installed package directories. The default
edition uses the original full dsh-purge plugin and local version-bound host
compatibility patches; the older prompt-only adapter above is a legacy module.
