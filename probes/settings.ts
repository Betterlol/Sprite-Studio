import { resolve } from 'node:path';

export const project = resolve('.local/project');
export const fixtureOverrides = [
  'features.shell_tool=false', 'features.unified_exec=false', 'features.view_image=false',
  'features.image_generation=false',
  `mcp_servers.sprite_probe.command=${JSON.stringify(process.execPath)}`,
  `mcp_servers.sprite_probe.args=${JSON.stringify([resolve('probes/mcp-fixture.ts'), project])}`,
  'mcp_servers.sprite_probe.enabled=true',
  'mcp_servers.sprite_probe.tools.write_note.approval_mode="approve"',
  'mcp_servers.sprite_probe.tools.submit_job.approval_mode="approve"',
];
