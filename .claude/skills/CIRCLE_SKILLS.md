# Circle skills (vendored)

From https://github.com/circlefin/skills (plugin `circle-skills` v1.8.1,
commit 1f23655), Apache-2.0 - see CIRCLE_SKILLS_LICENSE.
Copied unchanged.

Added: the 15 guidance-only skills (no `allowed-tools`).

Left out on purpose - they pre-approve commands that run without a prompt,
for Circle CLI agent wallets (not used by MeshPort):
- pay-via-agent-wallet (`circle services pay` - spends without asking)
- fund-agent-wallet, recover-eco-funds (wallet operations; signing scripts)
- accept-agent-payments (file edits + curl)

Circle's MCP server (https://api.circle.com/v1/codegen/mcp) is not configured.

To update: re-copy the same skill folders from a newer commit of that repo.
