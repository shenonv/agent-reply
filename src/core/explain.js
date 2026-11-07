// @ts-check
// Plain-English words for what each tool does. No AI: a lookup table plus a few details from the tool's input.

/** Last part of a path, for short labels. */
export const baseName = (p) => (typeof p === "string" ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : "");

const clip = (s, n = 70) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Words for a shell command: tests, installs, git and so on get their own label. */
function describeCommand(cmd, description) {
  const c = String(cmd ?? "");
  const sub = description ? clip(description) : clip(c);
  if (/^\s*git\b|\bgit\s+(?:push|commit|reset|checkout|merge|rebase|pull|clone)\b/i.test(c)) {
    return { title: "Uses version history (git)", subtitle: sub, what: "Claude ran a git command. Git keeps the history of every change to the project.", why: "Git is used to save, compare, share or undo changes." };
  }
  if (/\b(test|jest|vitest|pytest|mocha|go test|cargo test|dotnet test|phpunit|rspec)\b/i.test(c)) {
    return { title: "Runs the tests", subtitle: sub, what: "Claude ran the project's automatic checks to see whether the code works.", why: "Tests show whether a change broke anything." };
  }
  if (/\b(npm|pnpm|yarn|bun|pip|pip3|poetry|cargo|gem|composer|dotnet)\s+(i|install|add)\b/i.test(c)) {
    return { title: "Installs software", subtitle: sub, what: "Claude installed a package (a ready-made piece of code) into the project.", why: "Projects use packages so they don't have to write everything themselves." };
  }
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\b(?:cargo|dotnet|go|gradle|mvn)\s+build\b|^\s*(?:tsc|make|webpack)\b|\bvite\s+build\b/i.test(c)) {
    return { title: "Builds the project", subtitle: sub, what: "Claude turned the code into something that can run.", why: "Building catches mistakes and produces the finished program." };
  }
  return { title: "Runs a command", subtitle: sub, what: "Claude typed a command into the computer's terminal.", why: "Commands let Claude do things a text editor can't: run programs, look around, move files." };
}

/**
 * Plain-English description of one tool call.
 * @param {string} name
 * @param {any} input
 * @returns {{ icon: string, title: string, subtitle: string, what: string, why: string }}
 */
export function describeTool(name, input) {
  const i = input && typeof input === "object" ? input : {};
  switch (name) {
    case "Read":
      return { icon: "📄", title: "Reads a file", subtitle: baseName(i.file_path), what: "Claude opened a file to look at what's inside.", why: "Claude reads code before changing it, so it understands what's there." };
    case "Write":
      return { icon: "📝", title: "Writes a file", subtitle: baseName(i.file_path), what: "Claude created a file, or replaced everything in one.", why: "New files hold new code, notes or settings." };
    case "Edit":
    case "MultiEdit":
      return { icon: "✏️", title: "Changes a file", subtitle: baseName(i.file_path), what: "Claude replaced some text in a file with new text.", why: "Small, targeted edits are how Claude fixes and improves code." };
    case "NotebookEdit":
      return { icon: "📓", title: "Changes a notebook", subtitle: baseName(i.notebook_path), what: "Claude changed a cell in a Jupyter notebook.", why: "Notebooks mix code, results and notes." };
    case "Bash":
    case "PowerShell":
      return { icon: "⌨️", ...describeCommand(i.command, i.description) };
    case "BashOutput":
    case "TaskOutput":
      return { icon: "⏳", title: "Checks on a running command", subtitle: "", what: "Claude looked at the latest output of something running in the background.", why: "Long jobs run in the background while Claude keeps working." };
    case "KillShell":
    case "TaskStop":
      return { icon: "⏹️", title: "Stops a background job", subtitle: "", what: "Claude stopped something it had left running.", why: "Finished or stuck jobs are stopped to tidy up." };
    case "Grep":
      return { icon: "🔎", title: "Searches inside files", subtitle: clip(i.pattern, 50), what: "Claude searched the project's files for some text.", why: "Searching finds where something is used or defined." };
    case "Glob":
    case "LS":
      return { icon: "🗂️", title: "Looks for files", subtitle: clip(i.pattern ?? i.path, 50), what: "Claude listed files whose names match a pattern.", why: "Claude finds its way around a project before working in it." };
    case "WebFetch":
      return { icon: "🌐", title: "Reads a web page", subtitle: clip(i.url, 60), what: "Claude downloaded a web page and read it.", why: "Documentation and examples live on the web." };
    case "WebSearch":
      return { icon: "🌍", title: "Searches the web", subtitle: clip(i.query, 60), what: "Claude searched the internet.", why: "Some answers need up-to-date information." };
    case "Agent":
    case "Task":
      return { icon: "🤝", title: "Briefs a helper", subtitle: clip(i.description, 60), what: "Claude started a helper agent and gave it a job. The helper works on its own and reports back.", why: "Helpers can work in parallel or focus on one task without filling Claude's memory." };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { icon: "✅", title: "Updates its to-do list", subtitle: "", what: "Claude wrote down or ticked off the steps it plans to take.", why: "A to-do list keeps longer jobs on track." };
    case "AskUserQuestion":
      return { icon: "❓", title: "Asks you a question", subtitle: "", what: "Claude stopped to ask you to choose something.", why: "Some decisions are yours to make." };
    case "ExitPlanMode":
      return { icon: "🗺️", title: "Shows you a plan", subtitle: "", what: "Claude finished planning and asked you to approve the plan.", why: "In plan mode Claude agrees the approach with you before changing anything." };
    case "Skill":
      return { icon: "🧰", title: "Uses a skill", subtitle: clip(i.skill, 50), what: "Claude loaded a set of instructions for a particular kind of task.", why: "Skills teach Claude a specific way of working." };
    case "ToolSearch":
      return { icon: "🧩", title: "Loads extra tools", subtitle: "", what: "Claude loaded tools it didn't have ready.", why: "Rarely used tools are loaded only when needed." };
    default:
      if (name.startsWith("mcp__")) {
        const parts = name.split("__");
        const tool = parts.slice(2).join("__") || name;
        const server = parts[1] ?? "";
        const app = /^[0-9a-f-]{20,}$/i.test(server) ? "a connected app" : server.replace(/[_-]/g, " ");
        return { icon: "🔌", title: `Uses ${tool.replace(/_/g, " ")}`, subtitle: `from ${app}`, what: `Claude used a tool provided by ${app}.`, why: "Connected apps (MCP servers) give Claude extra abilities." };
      }
      return { icon: "🔧", title: `Uses ${name}`, subtitle: "", what: `Claude used the "${name}" tool.`, why: "Tools are how Claude does things beyond writing text." };
  }
}

/** Short explanations for words the page underlines. */
export const GLOSSARY = Object.freeze({
  helper: "A second Claude that the main Claude starts to do one job, then report back.",
  brief: "The instructions Claude gives a helper when it starts it.",
  report: "What a helper sends back to Claude when it has finished.",
  tokens: "Pieces of words. Claude reads and writes text in tokens; usage limits are counted in them.",
  cache: "Text Claude already read recently can be re-read from a cache, which is faster.",
  request: "One message you sent, and everything Claude did because of it.",
});
