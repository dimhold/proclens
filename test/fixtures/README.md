# Fixtures

Sample output for each platform, so the parsers can be tested without a live
process table.

Provenance, because it changes what a passing test proves:

- `windows-collect.json` — the **shape** was captured from the PowerShell
  helper in `src/collectors/windows.ts` on Windows 10 (Get-CimInstance
  Win32_Process plus Get-NetTCPConnection). Paths, user names and pids were
  replaced with generic ones before committing. The caret escaping in the
  `cmd.exe /d /s /c` entries and the `null` command lines are exactly what a
  non elevated shell returns.
- `linux-*.txt` — written to the documented formats of `/proc/<pid>/stat`,
  `/proc/net/tcp` and `ss -tulnpH`, not captured from a machine. If you run
  Linux and something here does not match your kernel, that is a bug worth
  reporting with your real output attached.
- `darwin-*.txt` — written to the documented formats of `ps -o lstart` and
  `lsof -F`, same caveat as above.
