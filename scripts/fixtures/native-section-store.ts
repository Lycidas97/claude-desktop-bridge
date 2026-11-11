import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeSectionCatalog } from "../../apps/desktop/src/claude/claude-desktop-inspector.js";

/** Synthetic active-account sidebar boundary. Writes only to its caller's temp profile. */
export async function createNativeSectionFixture(directory: string) {
  const profile = join(directory, "synthetic-sidebar.json");
  let scopes: Record<string, NativeSectionCatalog> = {};
  await writeFile(profile, JSON.stringify(scopes));
  const fixture = {
    profile, scope: "account-a/org-a", supported: true, failure: "", publishCreated: true,
    calls: [] as Array<{ method: string; scope: string; name?: string; sessionId?: string; sectionId?: string }>,
    async sections(): Promise<NativeSectionCatalog | undefined> {
      if (!fixture.supported) return undefined;
      scopes = JSON.parse(await readFile(profile, "utf8"));
      return structuredClone(scopes[fixture.scope] ?? { sections: [], assignments: {} });
    },
    async createSection(name: string): Promise<string> {
      fixture.calls.push({ method: "create_section", scope: fixture.scope, name });
      if (fixture.failure) throw new Error(fixture.failure);
      if (!fixture.scope) throw new Error("The sidebar isn't signed in to an account yet.");
      const catalog = scopes[fixture.scope] ??= { sections: [], assignments: {} };
      const existing = catalog.sections.find(section => section.name === name);
      if (existing) return existing.id;
      const id = randomUUID();
      if (fixture.publishCreated) catalog.sections.push({ id, name, order: catalog.sections.length });
      await writeFile(profile, JSON.stringify(scopes));
      return id;
    },
    async assignSection(sessionId: string, sectionId: string): Promise<void> {
      fixture.calls.push({ method: "move_sessions", scope: fixture.scope, sessionId, sectionId });
      if (fixture.failure) throw new Error(fixture.failure);
      const catalog = scopes[fixture.scope] ??= { sections: [], assignments: {} };
      if (sectionId === "sessions") delete catalog.assignments[sessionId];
      else catalog.assignments[sessionId] = sectionId;
      await writeFile(profile, JSON.stringify(scopes));
    },
    async reread(): Promise<void> { scopes = JSON.parse(await readFile(profile, "utf8")); },
  };
  return fixture;
}
