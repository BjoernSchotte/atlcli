import {
  ERROR_CODES,
  OutputOptions,
  clearProfileAuth,
  deleteKeychainToken,
  fail,
  getActiveProfile,
  getConfigPath,
  getFlag,
  getKeychainService,
  getLogger,
  hasFlag,
  hasKeychainToken,
  loadConfig,
  normalizeBaseUrl,
  output,
  promptConfirm,
  promptInput,
  removeProfile,
  renameProfile,
  saveConfig,
  setCurrentProfile,
  setKeychainToken,
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
      await handleDelete(args.slice(1), flags, opts);
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
    fail(opts, 1, ERROR_CODES.AUTH, "OAuth login is not implemented yet. Use --api-token or --bearer.");
  }

  const useBearer = hasFlag(flags, "bearer");

  const baseUrl = normalizeBaseUrl(
    getFlag(flags, "site") ||
      process.env.ATLCLI_SITE ||
      (interactive ? await promptInput(
        useBearer
          ? "Jira/Confluence site URL (e.g. https://jira.company.com): "
          : "Confluence site URL (e.g. https://example.atlassian.net): "
      ) : "")
  );
  if (!baseUrl) {
    fail(opts, 1, ERROR_CODES.AUTH, "Site URL is required.");
  }

  const profileName =
    getFlag(flags, "profile") ||
    slugify(new URL(baseUrl).hostname || "default") ||
    "default";

  const config = await loadConfig();

  if (useBearer) {
    // Bearer/PAT auth for Server/Data Center
    const username =
      getFlag(flags, "username") ||
      (interactive ? await promptInput("Username (for keychain lookup, optional): ") : "");

    // Token can come from flag, env, or interactive prompt
    let pat = getFlag(flags, "token") || (forceTokenPrompt ? "" : process.env.ATLCLI_API_TOKEN || "");
    let storedInKeychain = false;

    if (!pat && interactive) {
      // Check if we should use keychain
      if (username && process.platform === "darwin") {
        const useKeychain = await promptConfirm("Store token in Mac Keychain?", true);
        pat = await promptInput("Personal Access Token (PAT): ");
        if (useKeychain && pat) {
          const stored = setKeychainToken(getKeychainService(), username, pat);
          if (stored) {
            storedInKeychain = true;
            pat = ""; // Don't store in config if using keychain
          }
        }
      } else {
        pat = await promptInput("Personal Access Token (PAT): ");
      }
    }

    if (!pat && !storedInKeychain && !process.env.ATLCLI_API_TOKEN) {
      // No token in config, keychain, or env - this will fail at runtime
      // Allow it if a keychain entry already exists for this username
      const hasExistingKeychain =
        username && process.platform === "darwin"
          ? hasKeychainToken(getKeychainService(), username)
          : false;

      if (!hasExistingKeychain) {
        fail(opts, 1, ERROR_CODES.AUTH, "Personal Access Token is required. Provide via --token, ATLCLI_API_TOKEN env var, or store in keychain.");
      }
    }

    setProfile(config, {
      name: profileName,
      baseUrl,
      auth: {
        type: "bearer",
        username: username || undefined,
        pat: pat || undefined, // Only set if not using keychain
      },
    });
    setCurrentProfile(config, profileName);
    await saveConfig(config);

    // Log auth change
    getLogger().auth({
      action: "login",
      profile: profileName,
      username: username || undefined,
      baseUrl,
      authType: "bearer",
      keychainUsed: storedInKeychain,
    });

    output(
      {
        ok: true,
        profile: profileName,
        site: baseUrl,
        authType: "bearer",
        keychainUsed: storedInKeychain,
        configPath: getConfigPath(),
      },
      opts
    );
  } else {
    // Basic auth (apiToken) for Cloud
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
}

async function handleStatus(flags: Record<string, string | boolean | string[]>, opts: OutputOptions): Promise<void> {
  const config = await loadConfig();
  const profileName = getFlag(flags, "profile");
  const profile = getActiveProfile(config, profileName);
  if (!profile) {
    fail(opts, 1, ERROR_CODES.AUTH, "No active profile found. Run `atlcli auth login`." , { profile: profileName });
  }

  const result: Record<string, unknown> = {
    profile: profile.name,
    site: profile.baseUrl,
    authType: profile.auth.type,
  };

  // Show auth details based on type
  if (profile.auth.type === "bearer") {
    result.username = profile.auth.username;
    result.hasPatInConfig = !!profile.auth.pat;
    if (profile.auth.username && process.platform === "darwin") {
      result.hasKeychainToken = hasKeychainToken(getKeychainService(), profile.auth.username);
    }
    result.hasEnvToken = !!process.env.ATLCLI_API_TOKEN;
  } else if (profile.auth.type === "apiToken") {
    result.email = profile.auth.email;
    result.hasTokenInConfig = !!profile.auth.token;
    result.hasEnvToken = !!process.env.ATLCLI_API_TOKEN;
  }

  output(result, opts);
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
  const keychainUsername = profile.auth.username;

  // Delete keychain token if present
  let keychainDeleted = false;
  if (keychainUsername && process.platform === "darwin") {
    keychainDeleted = deleteKeychainToken(getKeychainService(), keychainUsername);
  }

  clearProfileAuth(config, target);
  if (!keychainDeleted && keychainUsername) {
    const updatedProfile = config.profiles[target];
    if (updatedProfile) {
      updatedProfile.auth.username = keychainUsername;
    }
  }
  await saveConfig(config);

  // Log auth change
  getLogger().auth({
    action: "logout",
    profile: target,
    baseUrl: profile.baseUrl,
    keychainDeleted,
  });

  output({
    ok: true,
    profile: target,
    message: "Logged out (credentials cleared)",
    keychainDeleted,
  }, opts);
}

async function handleDelete(
  args: string[],
  flags: Record<string, string | boolean | string[]>,
  opts: OutputOptions
): Promise<void> {
  const name = args[0];
  if (!name) {
    fail(opts, 1, ERROR_CODES.USAGE, "Profile name is required.");
  }
  const config = await loadConfig();
  if (!config.profiles[name]) {
    fail(opts, 1, ERROR_CODES.AUTH, `Profile not found: ${name}`);
  }
  const profile = config.profiles[name];
  const deleteKeychain = hasFlag(flags, "delete-keychain");
  let keychainDeleted = false;
  let warning: string | undefined;

  if (deleteKeychain && profile.auth.username) {
    if (process.platform === "darwin") {
      keychainDeleted = deleteKeychainToken(getKeychainService(), profile.auth.username);
      if (!keychainDeleted) {
        warning = "Failed to delete keychain credentials. Delete them manually if needed.";
      }
    } else {
      warning = "Keychain deletion is only supported on macOS.";
    }
  } else if (profile.auth.username) {
    warning = "Keychain credentials (if any) were not removed. Use --delete-keychain to remove them.";
  }

  removeProfile(config, name);
  await saveConfig(config);

  // Log auth change
  getLogger().auth({
    action: "delete",
    profile: name,
    baseUrl: profile.baseUrl,
    keychainDeleted: deleteKeychain ? keychainDeleted : undefined,
  });

  output(
    {
      ok: true,
      profile: name,
      message: "Profile deleted",
      warning,
    },
    opts
  );
}

function authHelp(): string {
  return `atlcli auth <command>

Manage authentication profiles for Atlassian Cloud and Server/Data Center.

Commands:
  login             Authenticate with API token or PAT (interactive)
  init              Initialize auth by pasting credentials
  status            Show current profile status
  list              List all profiles
  switch <name>     Switch active profile
  rename <old> <new> Rename a profile
  logout [name]     Clear credentials (keeps profile)
  delete <name>     Delete profile entirely

Options:
  --site <url>       Atlassian site URL
  --bearer           Use Bearer auth with PAT (for Server/Data Center)
  --token <token>    API token or PAT
  --username <user>  Username (for keychain lookup with --bearer)
  --email <email>    Email (for Cloud Basic auth)
  --profile <name>   Profile name for new login
  --delete-keychain  Delete keychain credentials when deleting a profile

Token Resolution Priority:
  1. ATLCLI_API_TOKEN environment variable (highest)
  2. Mac Keychain entry (if username provided)
  3. Config file (lowest)

Examples:
  # Cloud (Basic auth with email + API token)
  atlcli auth login --site https://mycompany.atlassian.net

  # Server/Data Center (Bearer auth with PAT)
  atlcli auth login --bearer --site https://jira.company.com

  # Server with keychain storage
  atlcli auth login --bearer --site https://jira.company.com --username myuser

  # Using environment variable (CI/scripts)
  export ATLCLI_API_TOKEN=your-pat-here
  atlcli jira issue get PROJ-123

  atlcli auth status
  atlcli auth list
  atlcli auth switch work
`;
}
