import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpServer } from '../src/mcp/core.js';
import { BLOG_ADMIN_ROLE, WIKI_ADMIN_ROLE } from '../src/services/roles.js';

test('MCP admin tools are disabled without admin roles', () => {
  const mcpWithoutRoles = createMcpServer({ userRoles: [] });

  assert.ok(mcpWithoutRoles.adminTools.wikiDeletePageTool);
  assert.ok(mcpWithoutRoles.adminTools.citationDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.claimDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.pageCheckDeleteTool);
  assert.ok(mcpWithoutRoles.adminTools.blogDeleteTool);

  assert.equal(mcpWithoutRoles.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.citationDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.claimDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.pageCheckDeleteTool.enabled, false);
  assert.equal(mcpWithoutRoles.adminTools.blogDeleteTool.enabled, false);
});

test('MCP wiki admin tools are enabled with wiki_admin role', () => {
  const mcpWithWikiAdmin = createMcpServer({ userRoles: [WIKI_ADMIN_ROLE] });

  assert.equal(mcpWithWikiAdmin.adminTools.wikiDeletePageTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.citationDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.claimDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.pageCheckDeleteTool.enabled, true);
  assert.equal(mcpWithWikiAdmin.adminTools.blogDeleteTool.enabled, false);
});

test('MCP blog admin tool is enabled with blog_admin role', () => {
  const mcpWithBlogAdmin = createMcpServer({ userRoles: [BLOG_ADMIN_ROLE] });

  assert.equal(mcpWithBlogAdmin.adminTools.blogDeleteTool.enabled, true);
  assert.equal(mcpWithBlogAdmin.adminTools.wikiDeletePageTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.citationDeleteTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.claimDeleteTool.enabled, false);
  assert.equal(mcpWithBlogAdmin.adminTools.pageCheckDeleteTool.enabled, false);
});
