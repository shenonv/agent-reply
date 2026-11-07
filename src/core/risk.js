// @ts-check
// Flags steps worth a second look. Plain pattern checks on what Claude ran or changed; no AI.
// "risky" = could lose work or expose something; "care" = normal but worth knowing about.

/** @typedef {{ level: "risky" | "care", reason: string }} Risk */

/** @type {[RegExp, string][]} */
const RISKY_COMMANDS = [
  [/\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|--force\s+--recursive)\b/i, "Deletes files and folders without asking"],
  [/\bRemove-Item\b[^|;&\n]*-Recurse/i, "Deletes files and folders without asking"],
  [/\b(?:rmdir|rd)\s+\/s\b/i, "Deletes a folder and everything in it"],
  [/\bdel\s+\/[sfq]/i, "Deletes files without asking"],
  [/\bgit\s+push\b[^|;&\n]*(?:--force\b|--force-with-lease\b|\s-f\b)/i, "Overwrites history on the shared copy of the project"],
  [/\bgit\s+reset\s+--hard\b/i, "Throws away changes that weren't saved in git"],
  [/\bgit\s+clean\s+-[a-z]*f/i, "Deletes files git isn't tracking"],
  [/\bgit\s+(?:checkout\s+(?:--\s+)?\.|restore\s+(?:--\S+\s+)*\.)(?:\s|$)/i, "Throws away unsaved changes in every file"],
  [/\bgit\s+branch\s+-D\b/, "Deletes a branch even if its work isn't merged"],
  [/\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression|python3?|node)\b/i, "Runs code straight from the internet"],
  [/(?:^|[\s;&|(])sudo\s/, "Runs with administrator rights"],
  [/\bchmod\s+(?:-R\s+)?0?777\b/, "Lets anyone change these files"],
  [/\b(?:npm|pnpm|yarn)\s+publish\b/i, "Publishes a package for everyone to download"],
  [/\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i, "Deletes data in a database"],
  [/\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:/i, "Can erase a whole disk"],
];

/** @type {[RegExp, string][]} */
const CARE_COMMANDS = [
  [/(?:^|[\s;&|(])(?:rm|del|erase|Remove-Item|ri|unlink)\s/i, "Deletes files"],
  [/\bgit\s+push\b/i, "Sends changes to the shared copy of the project"],
  [/\bgit\s+commit\b[^|;&\n]*--amend/i, "Rewrites the last saved change"],
  [/\b(?:npm|pnpm|yarn|bun|pip3?|poetry|cargo|gem|composer)\s+(?:i|install|add)\b/i, "Installs software from the internet"],
  [/\b(?:curl|wget|Invoke-WebRequest|iwr)\b/i, "Downloads something from the internet"],
  [/\b(?:kill|killall|pkill|taskkill|Stop-Process)\b/i, "Stops running programs"],
];

const SECRET_FILE = /(?:^|[\\/])\.env(?:\.[\w.-]+)?$|(?:^|[\\/])id_(?:rsa|ed25519|ecdsa)|\.pem$|\.key$|\.p12$|\.pfx$|(?:^|[\\/])\.npmrc$|(?:^|[\\/])\.pypirc$|(?:^|[\\/])\.netrc$|(?:^|[\\/])\.ssh[\\/]|credentials|secrets?\.(?:json|ya?ml|toml)$/i;

const COMMAND_TOOLS = new Set(["Bash", "PowerShell"]);
const CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * @param {{ tool?: string, input?: any }} step
 * @returns {Risk | null}
 */
export function riskOf(step) {
  const tool = step.tool;
  if (!tool) return null;
  const input = step.input ?? {};
  if (COMMAND_TOOLS.has(tool) && typeof input.command === "string") {
    const cmd = input.command;
    for (const [re, reason] of RISKY_COMMANDS) if (re.test(cmd)) return { level: "risky", reason };
    for (const [re, reason] of CARE_COMMANDS) if (re.test(cmd)) return { level: "care", reason };
    return null;
  }
  const file = input.file_path ?? input.notebook_path;
  if (typeof file === "string" && SECRET_FILE.test(file)) {
    if (CHANGE_TOOLS.has(tool)) return { level: "risky", reason: "Changes a file that holds passwords or keys" };
    if (tool === "Read") return { level: "care", reason: "Reads a file that may hold passwords or keys" };
  }
  return null;
}
