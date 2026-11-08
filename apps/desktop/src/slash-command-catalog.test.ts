import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverSlashCommands } from "./slash-command-catalog.js";

let root: string, cwd: string, claudeRoot: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bridge-slash-catalog-"));
  cwd = join(root, "project");
  claudeRoot = join(root, "personal");
  await mkdir(cwd);
});
afterEach(() => rm(root, { recursive: true, force: true }));
async function file(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

describe("discovered custom slash commands", () => {
  it("returns an empty list when neither approved directory exists", async () => {
    expect(await discoverSlashCommands(cwd, claudeRoot)).toEqual({ commands: [] });
  });

  it("preserves nested legacy names and YAML hints without returning the body", async () => {
    await file(join(cwd, ".claude/commands/frontend/component.md"), '---\nname: ignored-legacy-name\ndescription: "Review: component"\nargument-hint: "[path]"\n---\nPRIVATE_BODY_DO_NOT_RETURN\n');
    const result = await discoverSlashCommands(cwd, claudeRoot);
    expect(result.commands).toEqual([{ name: "frontend:component", description: "Review: component", argumentHint: "[path]" }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
    expect(JSON.stringify(result)).not.toContain(root);
  });

  it("discovers skill display names, directory aliases and folded descriptions", async () => {
    await file(join(claudeRoot, "skills/review/SKILL.md"), "---\nname: inspect-changes\ndescription: >-\n  Review changes\n  carefully\nargument-hint: '[file]'\n---\nDo not expose this skill body\n");
    expect((await discoverSlashCommands(cwd, claudeRoot)).commands).toEqual([
      { name: "inspect-changes", aliases: ["review"], description: "Review changes carefully", argumentHint: "[file]" },
    ]);
  });

  it("does not hide a user-only skill but hides a non-user-invocable skill", async () => {
    await file(join(cwd, ".claude/skills/manual/SKILL.md"), "---\ndisable-model-invocation: true\ndescription: Manual invocation\n---\nBody");
    await file(join(cwd, ".claude/skills/hidden/SKILL.md"), "---\nuser-invocable: false\n---\nBody");
    expect((await discoverSlashCommands(cwd, claudeRoot)).commands).toEqual([{ name: "manual", description: "Manual invocation" }]);
  });

  it("applies personal-over-project precedence and does not revive a hidden overridden command", async () => {
    await file(join(cwd, ".claude/skills/shared/SKILL.md"), "---\ndescription: Project version\n---\nBody");
    await file(join(claudeRoot, "skills/shared/SKILL.md"), "---\ndescription: Personal version\n---\nBody");
    await file(join(cwd, ".claude/skills/private/SKILL.md"), "---\ndescription: Old visible version\n---\nBody");
    await file(join(claudeRoot, "skills/private/SKILL.md"), "---\nuser-invocable: false\n---\nBody");
    expect((await discoverSlashCommands(cwd, claudeRoot)).commands).toEqual([{ name: "shared", description: "Personal version" }]);
  });

  it("prefers a skill over a same-named legacy command", async () => {
    await file(join(cwd, ".claude/skills/deploy/SKILL.md"), "---\ndescription: Skill version\n---\nBody");
    await file(join(claudeRoot, "commands/deploy.md"), "---\ndescription: Legacy version\n---\nBody");
    expect((await discoverSlashCommands(cwd, claudeRoot)).commands).toEqual([{ name: "deploy", description: "Skill version" }]);
  });

  it("keeps canonical directory names when a requested display name collides", async () => {
    await file(join(cwd, ".claude/skills/review/SKILL.md"), "---\nname: inspect\ndescription: Review skill\n---\nBody");
    await file(join(cwd, ".claude/skills/inspect/SKILL.md"), "---\ndescription: Inspect skill\n---\nBody");
    expect((await discoverSlashCommands(cwd, claudeRoot)).commands).toEqual([
      { name: "inspect", description: "Inspect skill" }, { name: "review", description: "Review skill" },
    ]);
  });

  it("limits discovery to the approved roots, rather than descendants and plugins", async () => {
    await file(join(cwd, ".claude/commands/local.md"), "No frontmatter: no body description is returned\n");
    await file(join(cwd, "nested/.claude/skills/nested/SKILL.md"), "---\ndescription: Lazy nested skill\n---\nBody");
    await file(join(claudeRoot, "plugins/plugin/skills/plugin/SKILL.md"), "---\ndescription: Plugin\n---\nBody");
    await file(join(claudeRoot, ".env"), "DO_NOT_DISCOVER=secret");
    expect((await discoverSlashCommands(cwd, claudeRoot)).commands).toEqual([{ name: "local", description: "" }]);
  });

  it("reports malformed metadata without including YAML snippets or dropping valid commands", async () => {
    await file(join(cwd, ".claude/commands/bad.md"), "---\ndescription: [PRIVATE_BAD_VALUE\n---\nPRIVATE_BODY\n");
    await file(join(cwd, ".claude/commands/good.md"), "---\ndescription: Valid command\n---\nBody");
    const result = await discoverSlashCommands(cwd, claudeRoot);
    expect(result.commands).toEqual([{ name: "good", description: "Valid command" }]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings![0]).toContain("bad.md");
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(JSON.stringify(result)).not.toContain(root);
  });
});
