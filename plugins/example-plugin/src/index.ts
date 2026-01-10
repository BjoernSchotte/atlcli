/**
 * Example plugin for atlcli.
 *
 * This plugin demonstrates how to:
 * - Add new commands with subcommands
 * - Use hooks to extend built-in commands
 * - Handle flags and arguments
 *
 * Usage:
 *   atlcli plugin install ./plugins/example-plugin
 *   atlcli hello world
 *   atlcli hello greet --name "Your Name"
 *
 * Note: For production plugins, import { definePlugin } from "@atlcli/plugin-api"
 * This example exports directly to avoid workspace dependency issues during development.
 */

// Plugin definition - implements AtlcliPlugin interface
export default {
  name: "example-plugin",
  version: "1.0.0",
  description: "Example plugin demonstrating the atlcli plugin API",

  // Add new commands
  commands: [
    {
      name: "hello",
      description: "Example hello command",
      subcommands: [
        {
          name: "world",
          description: "Say hello world",
          handler: async (ctx) => {
            if (ctx.output.json) {
              console.log(JSON.stringify({ message: "Hello, World!" }));
            } else {
              console.log("Hello, World!");
            }
          },
        },
        {
          name: "greet",
          description: "Greet someone by name",
          flags: [
            {
              name: "name",
              alias: "n",
              description: "Name to greet",
              hasValue: true,
              default: "stranger",
            },
            {
              name: "loud",
              alias: "l",
              description: "Use uppercase",
            },
          ],
          handler: async (ctx) => {
            const name = (ctx.flags.name as string) || "stranger";
            let message = `Hello, ${name}!`;

            if (ctx.flags.loud) {
              message = message.toUpperCase();
            }

            if (ctx.output.json) {
              console.log(JSON.stringify({ message, name }));
            } else {
              console.log(message);
            }
          },
        },
        {
          name: "time",
          description: "Show current time with greeting",
          handler: async (ctx) => {
            const now = new Date();
            const hour = now.getHours();
            let greeting: string;

            if (hour < 12) {
              greeting = "Good morning";
            } else if (hour < 18) {
              greeting = "Good afternoon";
            } else {
              greeting = "Good evening";
            }

            if (ctx.output.json) {
              console.log(
                JSON.stringify({
                  greeting,
                  time: now.toISOString(),
                  hour,
                })
              );
            } else {
              console.log(`${greeting}! The time is ${now.toLocaleTimeString()}.`);
            }
          },
        },
      ],
    },
  ],

  // Add hooks (optional)
  hooks: {
    // Log all commands (useful for debugging/auditing)
    beforeCommand: async (ctx) => {
      // Uncomment to enable command logging:
      // console.log(`[example-plugin] Running: atlcli ${ctx.command.join(" ")}`);
    },

    // Log command completion
    afterCommand: async (ctx) => {
      // Uncomment to enable completion logging:
      // console.log(`[example-plugin] Completed: atlcli ${ctx.command.join(" ")}`);
    },

    // Handle errors
    onError: async (ctx, error) => {
      // Uncomment to enable error logging:
      // console.error(`[example-plugin] Error in ${ctx.command.join(" ")}: ${error.message}`);
    },
  },

  // Initialization (optional)
  initialize: async () => {
    // Called when plugin is loaded
    // Use for async setup, database connections, etc.
  },

  // Cleanup (optional)
  cleanup: async () => {
    // Called when plugin is unloaded
    // Use for cleanup, closing connections, etc.
  },
};
