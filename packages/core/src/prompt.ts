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
