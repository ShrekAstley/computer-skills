# Safety model

computer-skills gives an agent broad access to your computer. The safety layer keeps you in control while allowing real automation. It is a **guard-rail, not a sandbox**: it makes risk explicit and routes consequential actions to you. For untrusted tasks use the `restricted` level, your client's own tool-permission prompts, and/or a VM.

## Risk classes

| Risk | Meaning | Examples |
|------|---------|----------|
| safe | read-only | `ls`, `git status`, screenshots, OCR, window lists, workflow search |
| low | ordinary local work | builds, tests, `mkdir`, launching apps, typing, clicking neutral controls |
| medium | noticeable side effects | `npm install`, `git push`, `kill`, `mv`, deleting single files, network writes, closing windows, consequential buttons ("Install", "Send", "Publish") |
| high | destructive or system-affecting | recursive delete, `sudo`, system package installs, `curl … \| sh`, force-push / `reset --hard`, service changes, registry edits, destructive buttons ("Delete", "Don't Save", "Replace"), app scripts that delete files or spawn processes, force-quit |
| critical | could damage the system or user data at scale | shutdown/reboot, disabling security controls, account changes, partitioning, writing into system dirs, deleting protected paths (`~`, `~/.ssh`, `/etc`, `C:\Windows` …), killing system processes |
| forbidden | never performed by the agent | `rm -rf /` or `~`, `--no-preserve-root`, `mkfs`, raw writes to disks, disk wipes, fork bombs, recursive delete of a drive root |

Classification considers compound commands (`;`, `&&`, pipes, `$(…)`), wrappers (`bash -c`, `powershell -EncodedCommand`, `cmd /c`), redirections that overwrite existing or protected files, and destructive verbs' path arguments. Typing into a terminal window is classified as the command it types. Clicking/pressing UI elements is classified by their label; hotkeys by their effect (`alt+f4`, lock screen, logout).

## Levels

| Risk | restricted | normal (default) | trusted (`autonomous`) |
|------|-----------|------------------|------------------------|
| safe | allow | allow | allow |
| low | confirm | allow | allow |
| medium | confirm | allow | allow |
| high | deny | confirm | allow |
| critical | deny | confirm | confirm |
| forbidden | deny | deny | deny |

Set with `COMPUTER_SKILLS_LEVEL` (in the MCP server environment or your shell) or `"safety": {"level": …}` in `~/.computer-skills/config.json`. The agent cannot change the level.

## Confirmation

1. If the client supports **MCP elicitation**, the user sees an approval prompt (approve once / approve this exact action for 30 minutes / deny). Declines are final for that action.
2. Otherwise the tool returns `CONFIRMATION_REQUIRED` with the reasons and a **single-use token** bound to the exact tool + arguments, valid for 5 minutes. The agent is instructed to ask you and pass `confirm` only after explicit approval. (The token proves the agent saw the warning; it cannot prove you approved — that is what elicitation and your client's permission prompts are for.)
3. The CLI (`computer-skills call`) asks on the terminal.

## Other controls

| Control | How |
|---------|-----|
| Kill switch | `computer-skills stop` (or create `~/.computer-skills/STOP`) — every non-read-only tool is refused until `computer-skills resume`. Agents can engage it (`safety stop`) but never release it. |
| Failsafe corner | Moving the mouse to the top-left corner (0,0) aborts any input action. `safety.failsafeCorner: false` to disable. |
| Protected paths | Defaults: home dir itself, credential folders (`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`), `~/.config`, Documents/Desktop/Pictures roots, system directories. Add more with `safety.protectedPaths`. Temp directories are never protected. |
| Blocked apps | `safety.blockedApps: ["1password", "keychain", "banking"]` — launching, scripting, focusing or typing into matching apps is forbidden. |
| Command patterns | `safety.denyCommands` (regex → forbidden) and `safety.allowCommands` (regex → low; cannot override forbidden). |
| Project configs | `<repo>/.computer-skills/config.json` can only **tighten** policy (lower level, extra deny patterns, protected paths, blocked apps) unless you set `safety.allowProjectEscalation: true` in your user config. A cloned repository cannot grant itself autonomy. |
| Audit log | Every decision is appended to `~/.computer-skills/logs/audit.jsonl` (`computer-skills audit`, `safety audit`). |

## Example config

```json
{
  "safety": {
    "level": "normal",
    "blockedApps": ["1Password", "Bitwarden", "Keychain Access"],
    "protectedPaths": ["~/work/production-secrets"],
    "denyCommands": ["\\bterraform\\s+destroy\\b", "\\bkubectl\\b.*--context\\s+prod"],
    "allowCommands": ["^rm -rf (dist|build|\\.cache)$"],
    "failsafeCorner": true
  }
}
```

## Agent obligations (from the skill)

Ask before destructive or consequential actions; never seek workarounds for denied actions; stop on the kill switch/failsafe; read dialogs before accepting; don't drive password managers or security settings; never type secrets that weren't given for that purpose; don't run GUI automation from parallel agents.
