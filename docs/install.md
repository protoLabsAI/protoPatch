---
title: Installation
description: "How to install clawpatch from npm or source"
---

# Installation

> This is the **protoLabs fork** (`protoLabsAI/protoPatch`). The upstream
> `openclaw/clawpatch` on npm does not include the `gateway` provider —
> see [Providers → gateway](providers.md#gateway) for what that adds.

## npm/pnpm

From the protoLabs npm package:

```bash
pnpm add -g @protolabsai/protopatch
```

Or with npm:

```bash
npm install -g @protolabsai/protopatch
```

Or pull straight from the repo to track `main`:

```bash
pnpm add -g github:protoLabsAI/protoPatch
```

Both `clawpatch` and `protopatch` are installed as CLI binaries — they point
at the same entry. The fork keeps `clawpatch` so existing workflows and the
rest of this documentation work unchanged.

Verify:

```bash
clawpatch --version
```

## From source

Clone and build:

```bash
git clone https://github.com/protoLabsAI/protoPatch.git
cd protoPatch
pnpm install
pnpm build
pnpm link --global
```

Verify:

```bash
clawpatch --version
clawpatch doctor
```

## Provider setup

clawpatch requires an AI provider for code review. The default is the local Codex CLI.

### Codex CLI

Install the Codex CLI so `codex --version` works locally. If available in your
environment:

```bash
brew install codex
```

Verify:

```bash
codex --version
clawpatch doctor
```

`clawpatch doctor` checks that the configured provider is available and can execute test queries.

## Next steps

- [Quickstart](quickstart.md) - Run your first review
- [Configuration](configuration.md) - Customize behavior
- [Providers](providers.md) - Other provider options
