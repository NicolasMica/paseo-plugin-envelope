/** The guideline's heading line, the stable marker that tells a prompt already has a guideline, whatever its wording. */
export const SECRETS_GUIDELINE_HEADING = "## Environment secrets";

/** Appended to the system prompt of new agents that receive at least one `.env` variable. It names no variable: the prompt is fixed at creation and would go stale. */
export const SECRETS_GUIDELINE = `${SECRETS_GUIDELINE_HEADING}

Your environment holds secrets that Paseo's Envelope plugin injected. Use them by reference ("$NAME") in the commands that need them. Never print a value: no \`echo\`, \`env\`, \`printenv\` or \`set\`, no \`cat\`, \`grep\` or \`head\` on a \`.env\` file, and no verbose or debug flag that prints auth headers. To check that a variable is set, run \`[ -n "$NAME" ] && echo set\`. If an expected variable is missing, tell the user instead of looking for the value elsewhere.`;

/** Whether `prompt` has a line that is exactly the guideline heading, ignoring surrounding whitespace. */
export function hasSecretsGuideline(prompt: string): boolean {
  return prompt.split("\n").some((line) => line.trim() === SECRETS_GUIDELINE_HEADING);
}
