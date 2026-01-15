import {
  ERROR_CODES,
  OutputOptions,
  clearProfileAuth,
  fail,
  getActiveProfile,
  getConfigPath,
  getFlag,
  getLogger,
  hasFlag,
  loadConfig,
  normalizeBaseUrl,
  output,
  promptInput,
  removeProfile,
  renameProfile,
  saveConfig,
  setCurrentProfile,
  setProfile,
  slugify,
} from "@atlcli/core";

export async function handleAuth(args: string[], flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const sub = args[0];

  // Show help if no subcommand
  if (!sub) {
    output(authHelp(), opts);
    return;
  }

  switch (sub) {
    case "login":
      await handleLogin(flags, opts);
      return;
    case "init":
      await handleInit(flags, opts);
      return;
    case "status":
      await handleStatus(flags, opts);
      return;
    case "list":
      await handleList(opts);
      return;
    case "switch":
      await handleSwitch(args.slice(1), opts);
      return;
    case "rename":
      await handleRename(args.slice(1), opts);
      return;
    case "logout":
      await handleLogout(args.slice(1), opts);
      return;
    case "delete":
      await handleDelete(args.slice(1), opts);
      return;
    default:
      output(authHelp(), opts);
      return;
  }
}

async function handleLogin(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  await handleLoginWithMode(flags, opts, { interactive: true, forceTokenPrompt: false });
}

async function handleInit(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  await handleLoginWithMode(flags, opts, { interactive: true, forceTokenPrompt: true });
}

async function handleLoginWithMode(
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions,
  mode: { interactive: boolean; forceTokenPrompt: boolean }
): Promise<void> {
  const { interactive, forceTokenPrompt } = mode;
  if (flags.oauth) {
    fail(opts, 1, ERROR_CODES.AUTH, "OAuth login is not implemented yet. Use --api-token.");
  }

  const baseUrl = normalizeBaseUrl(
    getFlag(flags, "site") ||
      process.env.ATLCLI_SITE ||
      (interactive ? await promptInput("Confluence site URL (e.g. https://example.atlassian.net): ") : "")
  );
  if (!baseUrl) {
    fail(opts, 1, ERROR_CODES.AUTH, "Site URL is required.");
  }

  const email =
    getFlag(flags, "email") ||
    process.env.ATLCLI_EMAIL ||
    (interactive ? await promptInput("Atlassian account email: ") : "");
  if (!email) {
    fail(opts, 1, ERROR_CODES.AUTH, "Email is required.");
  }

  let token = getFlag(flags, "token") || (forceTokenPrompt ? "" : process.env.ATLCLI_API_TOKEN || "");

  if (!token && interactive) {
    token = await promptInput("API token: ");
  }

  if (!token) {
    fail(opts, 1, ERROR_CODES.AUTH, "API token is required.");
  }

  const profileName =
    getFlag(flags, "profile") ||
    slugify(new URL(baseUrl).hostname || "default") ||
    "default";

  const config = await loadConfig();
  setProfile(config, {
    name: profileName,
    baseUrl,
    auth: {
      type: "apiToken",
      email,
      token,
    },
  });
  setCurrentProfile(config, profileName);
  await saveConfig(config);

  // Log auth change
  getLogger().auth({
    action: "login",
    profile: profileName,
    email,
    baseUrl,
  });

  output(
    {
      ok: true,
      profile: profileName,
      site: baseUrl,
      configPath: getConfigPath(),
    },
    opts
  );
}

async function handleStatus(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`." , { profile: profileName });
  }
  output(
    {
      profile: profile.name,
      site: profile.baseUrl,
      authType: profile.auth.type,
    },
    opts
  );
}

async function handleList(opts: OutputOptions): Promise<void> {
  const config = await loadConfig();
  const profiles = Object.values(config.profiles).map((p) => ({
    name: p.name,
    site: p.baseUrl,
    authType: p.auth.type,
    active: config.currentProfile === p.name,
  }));
  output({ profiles }, opts);
}

async function handleSwitch(args: string[], opts: OutputOptions): Promise<void> {
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Profile name is required.");
  }
  const config = await loadConfig();
  if (!config.profiles[name]) {
    fail(opts, 1, ERROR_CODES.AUTH, `Profile not found: ${name}`);
  }
  const profile = config.profiles[name];
  setCurrentProfile(config, name);
  await saveConfig(config);

  // Log auth change
  getLogger().auth({
    action: "switch",
    profile: name,
    baseUrl: profile.baseUrl,
  });

  output({ ok: true, profile: name }, opts);
}

async function handleRename(args: string[], opts: OutputOptions): Promise<void> {
  const oldName = args[0];
  const newName = args[1];
  if (!oldName || !newName) {
    fail(opts, 1, ERROR_CODES.USAGE, "Usage: atlcli auth rename <old-name> <new-name>");
  }
  const config = await loadConfig();
  if (!config.profiles[oldName]) {
    fail(opts, 1, ERROR_CODES.AUTH, `Profile not found: ${oldName}`);
  }
  if (config.profiles[newName]) {
    fail(opts, 1, ERROR_CODES.AUTH, `Profile already exists: ${newName}`);
  }
  renameProfile(config, oldName, newName);
  await saveConfig(config);

  // Log auth change
  getLogger().auth({
    action: "rename",
    profile: newName,
    details: { oldName, newName },
  });

  output({ ok: true, oldName, newName }, opts);
}

async function handleLogout(args: string[], opts: OutputOptions): Promise<void> {
  const name = args[0];
  const config = await loadConfig();
  const target = name ?? config.currentProfile;
  if (!target) {
    fail(opts, 1, ERROR_CODES.AUTH, "No profile specified and no active profile.");
  }
  if (!config.profiles[target]) {
    fail(opts, 1, ERROR_CODES.AUTH, `Profile not found: ${target}`);
  }
  const profile = config.profiles[target];
  clearProfileAuth(config, target);
  await saveConfig(config);

  // Log auth change
  getLogger().auth({
    action: "logout",
    profile: target,
    baseUrl: profile.baseUrl,
  });

  output({ ok: true, profile: target, message: "Logged out (credentials cleared)" }, opts);
}

async function handleDelete(args: string[], opts: OutputOptions): Promise<void> {
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Profile name is required.");
  }
  const config = await loadConfig();
  if (!config.profiles[name]) {
    fail(opts, 1, ERROR_CODES.AUTH, `Profile not found: ${name}`);
  }
  const profile = config.profiles[name];
  removeProfile(config, name);
  await saveConfig(config);

  // Log auth change
  getLogger().auth({
    action: "delete",
    profile: name,
    baseUrl: profile.baseUrl,
  });

  output({ ok: true, profile: name, message: "Profile deleted" }, opts);
}

function authHelp(): string {
  return `atlcli auth <command>

Commands:
  login                    Authenticate (default: API token, prompts)
  init                     Initialize auth by pasting an API token
  status                   Show active profile
  list                     List profiles
  switch <name>            Switch active profile
  rename <old> <new>       Rename a profile
  logout [name]            Log out (clear credentials, keep profile)
  delete <name>            Delete a profile entirely

Options:
  --api-token      Use API token auth (default)
  --oauth          OAuth login (not implemented)
  --site <url>     Atlassian site URL
  --email <email>  Atlassian email
  --token <token>  API token
  --profile <name> Profile name
`;
}
