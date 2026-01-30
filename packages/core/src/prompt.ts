import readline from "node:readline";

export async function promptInput(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (value) => resolve(value));
  });

  rl.close();
  return answer.trim();
}

export async function promptConfirm(question: string, defaultValue = false): Promise<boolean> {
  const hint = defaultValue ? "[Y/n]" : "[y/N]";
  const answer = await promptInput(`${question} ${hint} `);
  if (!answer) return defaultValue;
  return answer.toLowerCase().startsWith("y");
}
