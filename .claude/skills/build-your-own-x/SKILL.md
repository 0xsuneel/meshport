---
name: build-your-own-x
description: Curated step-by-step tutorials for re-creating technologies from scratch (from codecrafters-io/build-your-own-x). Use when the user wants to learn how something works by building it - "build my own X", "implement X from scratch", "how does a blockchain / database / git / shell / web server / regex engine / interpreter / neural network work under the hood" - or asks for a tutorial, learning path or reference implementation for such a project.
---

# Build Your Own X

> *What I cannot create, I do not understand* - Richard Feynman

`tutorials.md` (next to this file) is a snapshot of the
[build-your-own-x](https://github.com/codecrafters-io/build-your-own-x) list:
step-by-step guides, grouped by technology, each tagged with its language.

Categories: 3D Renderer, AI Model, Augmented Reality, BitTorrent Client,
Blockchain / Cryptocurrency, Bot, Command-Line Tool, Database, Distributed
Systems, Docker, Emulator / Virtual Machine, Front-end Framework / Library,
Game, Git, Memory Allocator, Network Stack, Neural Network, Operating System,
Physics Engine, Processor, Programming Language, Regex Engine, Search Engine,
Shell, Template Engine, Text Editor, Visual Recognition System, Voxel Engine,
Web Browser, Web Server, Uncategorized.

## How to use

1. Find the matching section: `grep -n "Build your own \`<Category>\`" tutorials.md`,
   then read that section (each runs until the next `####` heading). For a topic
   with no category of its own (DNS server, package manager, chat...), grep the
   `Uncategorized` section and the whole file by keyword.
2. Filter by the language the user wants (entries start with `**Language**:`).
   In this repo (MeshPort: TypeScript/React) prefer **TypeScript** / **JavaScript**
   / **Node.js** entries unless told otherwise.
3. Recommend 1-3 tutorials with a sentence each on why they fit (scope, language,
   depth). Give the links exactly as listed.
4. If the user wants to actually build it, outline milestones following the chosen
   tutorial's structure and implement step by step, explaining the core concepts
   rather than just pasting finished code. Fetch the tutorial page itself when
   its details matter - don't reconstruct it from memory.

Links are from a snapshot and can go stale; if one fails, say so and suggest the
next-best entry. For the live list, fetch
`https://raw.githubusercontent.com/codecrafters-io/build-your-own-x/master/README.md`.
