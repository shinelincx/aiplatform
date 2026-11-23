export interface DecisionQuestion {
  question: string;
  options: string[];
}

export interface TaskDecision extends DecisionQuestion {
  id: string;
  answer?: string;
}

export function parseDecisionQuestions(value: unknown): DecisionQuestion[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const questions: DecisionQuestion[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || typeof item.question !== 'string' || !Array.isArray(item.options)) return null;
    const question = item.question.trim();
    if (!question || question.length > 500 || questions.some((entry) => entry.question === question)) return null;
    if (item.options.length < 2 || item.options.length > 4) return null;
    const options: string[] = [];
    for (const value of item.options) {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 250 || options.includes(value.trim())) return null;
      options.push(value.trim());
    }
    questions.push({ question, options });
  }
  return questions;
}

export function parseDecisionReply(message: string) {
  const match = /^ADO_DECISIONS\s*\n(\[[\s\S]*\])$/u.exec(message.trim());
  if (!match || match[1].length > 14_000) return null;
  try {
    return parseDecisionQuestions(JSON.parse(match[1]));
  } catch {
    return null;
  }
}
