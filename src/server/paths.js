// @ts-check
// Finds Claude Code's logs and turns the browser's opaque ids into file paths, safely.
// The browser never sends a path: it sends a project folder name and a session id, and both must match a real
// entry inside the logs folder. Symlinks are refused so nothing can point us outside it.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Claude Code's folder: $CLAUDE_CONFIG_DIR (the same variable Claude Code uses) or ~/.claude. */
export function claudeRoot() {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".claude");
}

export const projectsRoot = () => path.join(claudeRoot(), "projects");

export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
export const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,100})\.(jsonl|meta\.json)$/;

/** A single folder name: no separators, no "." or "..", no control characters, not too long. */
export function isSafeName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    name !== "." &&
    name !== ".." &&
    !/[\\/:\0*?"<>|]/.test(name) &&
    !/[\u0000-\u001f]/.test(name)
  );
}

/** True when `child` is strictly inside `parent` (both already resolved). */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The real (symlink-free) path of the projects folder, or null when Claude Code hasn't made it yet. */
export async function realProjectsRoot() {
  try {
    return await fs.realpath(projectsRoot());
  } catch {
    return null;
  }
}

/** A regular file (not a symlink) whose real path is inside root. */
async function isSafeFile(root, file) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile() || st.isSymbolicLink()) return false;
    return isInside(root, await fs.realpath(file));
  } catch {
    return false;
  }
}

/** A real folder (not a symlink) whose real path is inside root. */
async function isSafeDir(root, dir) {
  try {
    const st = await fs.lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    return isInside(root, await fs.realpath(dir));
  } catch {
    return false;
  }
}

/**
 * Turns (project folder name, session id) into file paths, or null if anything about it is off.
 * @returns {Promise<null | { root: string, file: string, projectDir: string, subagentsDir: string }>}
 */
export async function resolveSession(projectId, sessionId) {
  if (!isSafeName(projectId) || typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) return null;
  const root = await realProjectsRoot();
  if (!root) return null;
  let names;
  try {
    names = await fs.readdir(root);
  } catch {
    return null;
  }
  if (!names.includes(projectId)) return null; // must be an existing entry, exactly
  const projectDir = path.join(root, projectId);
  if (!(await isSafeDir(root, projectDir))) return null;
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  if (!(await isSafeFile(root, file))) return null;
  return { root, file, projectDir, subagentsDir: path.join(projectDir, sessionId, "subagents") };
}

/**
 * Helper-agent files for a session: agent-<id>.jsonl and agent-<id>.meta.json. Missing folder → empty list.
 * @returns {Promise<{ id: string, kind: "jsonl" | "meta", file: string }[]>}
 */
export async function listAgentFiles(root, subagentsDir) {
  if (!(await isSafeDir(root, subagentsDir))) return [];
  let entries;
  try {
    entries = await fs.readdir(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue; // Dirent.isFile() is false for symlinks
    const m = AGENT_FILE.exec(e.name);
    if (!m) continue;
    out.push({ id: m[1], kind: /** @type {"jsonl" | "meta"} */ (m[2] === "jsonl" ? "jsonl" : "meta"), file: path.join(subagentsDir, e.name) });
  }
  return out;
}

/**
 * Every session file, newest first.
 * @returns {Promise<{ projectId: string, sessionId: string, file: string, mtimeMs: number, size: number }[]>}
 */
export async function listSessionFiles(limit = 1000) {
  const root = await realProjectsRoot();
  if (!root) return [];
  const out = [];
  let projects;
  try {
    projects = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const p of projects) {
    if (!p.isDirectory() || !isSafeName(p.name)) continue; // isDirectory() is false for symlinks
    const dir = path.join(root, p.name);
    let files;
    try {
      files = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
      const sessionId = f.name.slice(0, -".jsonl".length);
      if (!SESSION_ID.test(sessionId)) continue;
      const file = path.join(dir, f.name);
      try {
        const st = await fs.stat(file);
        out.push({ projectId: p.name, sessionId, file, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // deleted while listing
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}
