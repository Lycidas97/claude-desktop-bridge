import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNativeSectionFixture } from "../../../../scripts/fixtures/native-section-store.js";
import { fixture } from "./claude-desktop-bridge-fixture.js";
import {
  CLAUDE_UNSECTIONED_PROJECT_ID,
  CLAUDE_UNSECTIONED_PROJECT_NAME,
  ClaudeDesktopBridge,
  WorkspaceTrustRequiredError,
} from "./claude-desktop-bridge.js";
import { NativeCallError } from "./claude-desktop-inspector.js";

describe("native Sections", () => {
  it("reads back a persisted empty native group, retains it after reconnect/restart, and isolates account/org scopes", async () => {
    const f = await fixture();
    let restarted: ClaudeDesktopBridge | undefined;
    try {
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).toContain("section.create");
      const project = await f.bridge.createSection("Research");
      expect(project).toMatchObject({ name: "Research", kind: "desktop-group", cwd: "", sessionCount: 0 });
      const saved = JSON.parse(await readFile(sections.profile, "utf8"));
      expect(saved["account-a/org-a"].sections).toEqual([{ id: project.projectId, name: "Research", order: 0 }]);
      expect(await f.bridge.createSection("Research")).toEqual(project);
      sections.scope = "account-a/org-b";
      await f.bridge.refreshRuntime();
      expect(f.bridge.listProjects().some(value => value.projectId === project.projectId)).toBe(false);
      const other = await f.bridge.createSection("Other org");
      expect(sections.calls.at(-1)).toMatchObject({ scope: "account-a/org-b", name: "Other org" });
      sections.scope = "account-b/org-a";
      await f.bridge.refreshRuntime();
      expect(f.bridge.listProjects().filter(value => value.kind === "desktop-group")).toEqual([]);
      sections.scope = "account-a/org-a";
      await sections.reread();
      await f.native.close();
      await f.bridge.refreshRuntime();
      expect(f.bridge.listProjects().find(value => value.projectId === project.projectId)).toEqual(project);
      await f.bridge.close();
      restarted = new ClaudeDesktopBridge(f.options);
      await restarted.initialize();
      expect(restarted.listProjects().filter(value => value.kind === "desktop-group")).toEqual([project]);
      expect(restarted.listProjects().some(value => value.projectId === other.projectId)).toBe(false);
      expect(f.native.calls.every(call => call.method !== "start")).toBe(true);
    } finally { await restarted?.close(); await f.close(); }
  });

  it("assigns a newly created session to its selected native Section and projects native membership", async () => {
    const f = await fixture();
    try {
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      const project = await f.bridge.createSection("Research");
      const session = await f.bridge.createSession("/new-project", "New", project.projectId);
      expect(sections.calls.at(-1)).toEqual({ method: "move_sessions", scope: "account-a/org-a", sessionId: session.sessionId, sectionId: project.projectId });
      expect(session).toMatchObject({ projectId: project.projectId, projectName: "Research", cwd: "/new-project" });
      expect(f.bridge.listProjects().find(value => value.projectId === project.projectId)).toMatchObject({ sessionCount: 1 });
    } finally { await f.close(); }
  });

  it("rejects a Section deleted after the last refresh before starting any native session", async () => {
    const f = await fixture();
    try {
      const sections = await createNativeSectionFixture(f.directory);
      const assignSection = vi.fn().mockRejectedValue(new NativeCallError("No section with that id exists"));
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection });
      await f.bridge.refreshRuntime();
      const project = await f.bridge.createSection("Research");
      await writeFile(sections.profile, JSON.stringify({ "account-a/org-a": { sections: [], assignments: {} } }));
      expect(f.bridge.listProjects().some(value => value.projectId === project.projectId)).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(f.bridge.createSession("/new-project", "New", project.projectId)).rejects.toThrow();
      }
      expect(f.native.calls.filter(call => call.method === "start")).toEqual([]);
      expect(assignSection).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it.each(["D:\\PARA", "/Users/lycidas/work/new-folder"])("sanitizes WorkspaceTrustError, authorizes via saveTrust on confirmation, and falls back to manual when required (%s)", async cwd => {
    const f = await fixture();
    try {
      f.native.untrustedCwds.add(cwd);
      expect(f.bridge.capabilities()).toContain("workspace.trust");
      await expect(f.bridge.createSession(cwd, "Untrusted")).rejects.toEqual(new WorkspaceTrustRequiredError(false));
      expect(f.native.calls.some(call => call.method === "saveTrust")).toBe(false);

      const created = await f.bridge.createSession(cwd, "Untrusted", undefined, true);
      expect(created.cwd).toBe(cwd);
      expect(f.native.calls.filter(call => call.method === "saveTrust")).toEqual([{ method: "saveTrust", args: [cwd] }]);

      f.native.untrustedCwds.add(cwd);
      f.native.keepUntrustedAfterSave = true;
      await expect(f.bridge.createSession(cwd, "Still untrusted", undefined, true)).rejects.toEqual(new WorkspaceTrustRequiredError(true));

      f.native.keepUntrustedAfterSave = false;
      f.native.unsupported.add("saveTrust");
      expect(f.bridge.capabilities()).not.toContain("workspace.trust");
      await expect(f.bridge.createSession(cwd, "Manual desktop")).rejects.toEqual(new WorkspaceTrustRequiredError(true));
    } finally { await f.close(); }
  });

  it("rejects legacy capability, native errors and creation without authoritative readback", async () => {
    const f = await fixture();
    try {
      await expect(f.bridge.createSection("Research")).rejects.toThrow("does not support Sections");
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      sections.failure = "Native section limit reached";
      await expect(f.bridge.createSection("Research")).rejects.toThrow(sections.failure);
      sections.failure = "";
      sections.publishCreated = false;
      await expect(f.bridge.createSection("Research")).rejects.toThrow("has not published");
      expect(f.bridge.listProjects().some(value => value.kind === "desktop-group")).toBe(false);
      sections.supported = false;
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).not.toContain("section.create");
      expect(f.bridge.capabilities()).not.toContain("section.move");
      expect(f.native.calls.every(call => call.method !== "start")).toBe(true);
    } finally { await f.close(); }
  });

  it("moves existing sessions into, between and out of native Sections while preserving cwd and eligibility gates", async () => {
    const f = await fixture();
    try {
      f.native.sessions.push(
        { sessionId: "local-archived", cwd: "/archived", title: "Archived", isArchived: true, turnRunning: false },
        { sessionId: "local-scheduled", cwd: "/scheduled", title: "Scheduled", scheduledTaskId: "task-1", turnRunning: false },
      );
      await expect(f.bridge.moveSessionSection("local-native", null)).rejects.toThrow("does not support Sections");
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, { sections: sections.sections, createSection: sections.createSection, assignSection: sections.assignSection });
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).toContain("section.move");
      expect(f.bridge.session("local-native")?.allowedActions?.canMoveSection).toBe(true);
      expect(f.bridge.session("local-archived")?.allowedActions?.canMoveSection).toBeUndefined();
      expect(f.bridge.session("local-scheduled")?.allowedActions?.canMoveSection).toBeUndefined();

      const zahuo = await f.bridge.createSection("杂活");
      const research = await f.bridge.createSection("Research");
      const originalProjectId = f.bridge.session("local-native")!.projectId;
      const originalCwd = f.bridge.session("local-native")!.cwd;

      const inZahuo = await f.bridge.moveSessionSection("local-native", zahuo.projectId);
      expect(inZahuo).toMatchObject({ projectId: zahuo.projectId, projectName: "杂活", cwd: originalCwd });
      expect(f.bridge.listProjects().find(value => value.projectId === zahuo.projectId)).toMatchObject({ sessionCount: 1 });

      const inResearch = await f.bridge.moveSessionSection("local-native", research.projectId);
      expect(inResearch).toMatchObject({ projectId: research.projectId, projectName: "Research", cwd: originalCwd });
      expect(f.bridge.listProjects().find(value => value.projectId === zahuo.projectId)).toMatchObject({ sessionCount: 0 });
      expect(f.bridge.listProjects().find(value => value.projectId === research.projectId)).toMatchObject({ sessionCount: 1 });

      const ungrouped = await f.bridge.moveSessionSection("local-native", null);
      expect(sections.calls.at(-1)).toEqual({ method: "move_sessions", scope: "account-a/org-a", sessionId: "local-native", sectionId: "sessions" });
      expect(ungrouped).toMatchObject({ projectId: originalProjectId, cwd: originalCwd });
      expect(f.bridge.listProjects().find(value => value.projectId === research.projectId)).toMatchObject({ sessionCount: 0 });
      expect(f.bridge.listProjects().some(value => value.projectId === originalProjectId)).toBe(true);

      await expect(f.bridge.moveSessionSection("local-archived", zahuo.projectId)).rejects.toThrow("cannot be moved");
      await expect(f.bridge.moveSessionSection("local-scheduled", zahuo.projectId)).rejects.toThrow("cannot be moved");
      await expect(f.bridge.moveSessionSection("local-native", originalProjectId)).rejects.toThrow("no longer available");
    } finally { await f.close(); }
  });

  it("renames and deletes native Sections while returning assigned sessions to their default project directories", async () => {
    const f = await fixture();
    try {
      await expect(f.bridge.renameSection("missing", "Next")).rejects.toThrow("does not support Sections");
      await expect(f.bridge.deleteSection("missing")).rejects.toThrow("does not support Sections");
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, {
        sections: sections.sections,
        createSection: sections.createSection,
        assignSection: sections.assignSection,
        renameSection: sections.renameSection,
        deleteSection: sections.deleteSection,
      });
      await f.bridge.refreshRuntime();
      expect(f.bridge.capabilities()).toContain("section.rename");
      expect(f.bridge.capabilities()).toContain("section.delete");

      const originalProjectId = f.bridge.session("local-native")!.projectId;
      const originalCwd = f.bridge.session("local-native")!.cwd;
      const created = await f.bridge.createSection("破甲");
      await f.bridge.moveSessionSection("local-native", created.projectId);
      expect(f.bridge.session("local-native")).toMatchObject({ projectId: created.projectId, projectName: "破甲" });

      const renamed = await f.bridge.renameSection(created.projectId, "Bridge 开发维护");
      expect(renamed).toMatchObject({ projectId: created.projectId, name: "Bridge 开发维护", kind: "desktop-group", sessionCount: 1 });
      expect(f.bridge.session("local-native")).toMatchObject({ projectId: created.projectId, projectName: "Bridge 开发维护", cwd: originalCwd });

      await f.bridge.deleteSection(created.projectId);
      expect(f.bridge.listProjects().some(project => project.projectId === created.projectId)).toBe(false);
      expect(f.bridge.session("local-native")).toMatchObject({ projectId: originalProjectId, cwd: originalCwd });

      await expect(f.bridge.renameSection(created.projectId, "Gone")).rejects.toThrow("no longer available");
      await expect(f.bridge.deleteSection(created.projectId)).rejects.toThrow("no longer available");
    } finally { await f.close(); }
  });

  it("unifies unsectioned sessions under 未分组 when Sections are active, avoids same-name folder collisions, and allows creating into claude-unsectioned", async () => {
    const f = await fixture();
    try {
      const zahuoDir = join(f.directory, "work", "杂活");
      const latestActiveDir = join(f.directory, "work", "bridge-latest");
      const archivedDir = join(f.directory, "work", "archived-newer");
      await Promise.all([mkdir(zahuoDir, { recursive: true }), mkdir(latestActiveDir, { recursive: true }), mkdir(archivedDir, { recursive: true })]);
      f.native.sessions = [
        { sessionId: "sectioned-zahuo", cwd: join(zahuoDir, "subtool"), title: "Sectioned task", lastActivityAt: 100, turnRunning: false },
        { sessionId: "unsectioned-zahuo", cwd: zahuoDir, title: "Unsectioned same-name folder", lastActivityAt: 200, turnRunning: false },
        { sessionId: "unsectioned-latest", cwd: latestActiveDir, title: "Latest active unsectioned", lastActivityAt: 400, turnRunning: false },
        { sessionId: "unsectioned-archived", cwd: archivedDir, title: "Archived unsectioned", isArchived: true, lastActivityAt: 900, turnRunning: false },
      ];

      // Legacy Desktop without Sections keeps per-directory project IDs and folder basenames.
      await f.bridge.refreshRuntime();
      expect(f.bridge.session("unsectioned-zahuo")).toMatchObject({ projectName: "杂活", cwd: zahuoDir });
      expect(f.bridge.session("unsectioned-zahuo")?.projectId).not.toBe(CLAUDE_UNSECTIONED_PROJECT_ID);

      // Enabling Sections unifies all unassigned sessions under 未分组 without altering session.cwd.
      const sections = await createNativeSectionFixture(f.directory);
      Object.assign(f.native, {
        sections: sections.sections,
        createSection: sections.createSection,
        assignSection: sections.assignSection,
        renameSection: sections.renameSection,
        deleteSection: sections.deleteSection,
      });
      await f.bridge.refreshRuntime();
      const zahuoSection = await f.bridge.createSection("杂活");
      await f.bridge.moveSessionSection("sectioned-zahuo", zahuoSection.projectId);

      expect(f.bridge.session("sectioned-zahuo")).toMatchObject({
        projectId: zahuoSection.projectId,
        projectName: "杂活",
        cwd: join(zahuoDir, "subtool"),
      });
      expect(f.bridge.session("unsectioned-zahuo")).toMatchObject({
        projectId: CLAUDE_UNSECTIONED_PROJECT_ID,
        projectName: CLAUDE_UNSECTIONED_PROJECT_NAME,
        cwd: zahuoDir,
      });
      expect(f.bridge.session("unsectioned-latest")).toMatchObject({
        projectId: CLAUDE_UNSECTIONED_PROJECT_ID,
        projectName: CLAUDE_UNSECTIONED_PROJECT_NAME,
        cwd: latestActiveDir,
      });

      const projects = f.bridge.listProjects();
      expect(projects.filter(project => project.name === "杂活")).toHaveLength(1);
      expect(projects.find(project => project.projectId === zahuoSection.projectId)).toMatchObject({
        name: "杂活",
        kind: "desktop-group",
        sessionCount: 1,
      });
      const unsectionedProject = projects.find(project => project.projectId === CLAUDE_UNSECTIONED_PROJECT_ID);
      expect(unsectionedProject).toMatchObject({
        projectId: CLAUDE_UNSECTIONED_PROJECT_ID,
        name: CLAUDE_UNSECTIONED_PROJECT_NAME,
        cwd: latestActiveDir,
        sessionCount: 3,
      });
      expect(unsectionedProject?.kind).toBeUndefined();

      // When 0 unsectioned sessions exist, claude-unsectioned is omitted from listProjects(), yet createSession(..., CLAUDE_UNSECTIONED_PROJECT_ID) succeeds without assignSection.
      f.native.sessions = [f.native.sessions[0]!];
      await f.bridge.refreshRuntime();
      expect(f.bridge.listProjects().some(project => project.projectId === CLAUDE_UNSECTIONED_PROJECT_ID)).toBe(false);
      sections.calls.length = 0;
      const createdUnsectioned = await f.bridge.createSession(zahuoDir, "Explicit unsectioned", CLAUDE_UNSECTIONED_PROJECT_ID);
      expect(sections.calls.some(call => call.method === "move_sessions")).toBe(false);
      expect(createdUnsectioned).toMatchObject({
        projectId: CLAUDE_UNSECTIONED_PROJECT_ID,
        projectName: CLAUDE_UNSECTIONED_PROJECT_NAME,
        cwd: zahuoDir,
      });
    } finally { await f.close(); }
  });
});
