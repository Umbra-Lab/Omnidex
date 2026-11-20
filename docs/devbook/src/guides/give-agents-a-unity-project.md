# Give agents a Unity project

This guide indexes a Unity project and your downloaded Asset Store packages so that Claude Code or Codex can look up scenes, prefabs, materials and their dependencies through the oracle, without the Unity Editor open.

Omnidex only reads. It never writes into `Assets/`, never touches `Library/`, and stores its index in its own `omnidex.db`, so it is safe to point at a project you are working in.

## 1. Add the folders

In Settings → Folders, choose **Add a folder** and set **Contains** to **Unity projects and .unitypackage files**. Add whichever of these you have:

- The project folder, or a folder that holds several projects.
- The Asset Store download cache, where the Package Manager keeps packages you bought. On Windows it is `%APPDATA%\Unity\Asset Store-5.x`; on macOS, `~/Library/Unity/Asset Store-5.x`.

Then choose **Scan**. A rescan only rereads files whose size or modification time changed.

```admonish note title="Text serialization"
Dependencies and outlines come from Unity's text (YAML) serialization, which is the default (Project Settings → Editor → Asset Serialization → Force Text). Files saved as binary are still listed, with no references.
```

## 2. Register the oracle

```bash
claude mcp add omnidex-oracle -- node <repo>/scripts/oracle-mcp/server.mjs
codex mcp add omnidex-oracle -- node <repo>/scripts/oracle-mcp/server.mjs
```

The four Unity tools are described in [The oracle MCP server](../subsystems/oracle-mcp.md). A good first call is `unity_projects`.

## 3. Pair it with an Editor MCP server

The oracle answers questions about what exists. Changing the project (creating objects, editing components, entering Play Mode, reading the console, taking screenshots) needs an MCP server that runs inside the Editor. Ask the oracle first and spend Editor calls only on the change itself: oracle lookups are cheap and work with the Editor closed.

| Server | Cost | Notes |
|---|---|---|
| [MCP for Unity](https://github.com/CoplayDev/unity-mcp) (CoplayDev) | Free, MIT | Unity 2021.3 LTS to Unity 6; needs Python 3.10+ and `uv`. Scenes, GameObjects, scripts, assets, tests, builds. |
| [Unity-MCP](https://github.com/IvanMurzak/Unity-MCP) (IvanMurzak) | Free core, Apache 2.0 | Also works in built players; any C# method can become a tool. The project path must not contain spaces. |
| [Unity CLI](https://docs.unity.com/en-us/unity-cli/replace-mcp-server-unity-cli.md) (Unity) | Free, no Unity AI subscription | Unity's official route since November 2026, still in beta. Drives a running Editor on Unity 6.0 LTS or later over localhost. Agents with a shell call `unity command` and `unity eval` directly; `unity mcp` serves clients without one. Replaces the deprecated MCP server in `com.unity.ai.assistant`. |

Use the Unity CLI when the project is on Unity 6 and you want Unity's supported path. Use MCP for Unity for older Editors, or when the CLI's beta gaps get in the way.
