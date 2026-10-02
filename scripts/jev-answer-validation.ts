/** V4.4 typed-answer checks, adapted to the existing shared Jev client.
 * Older callers allow omitted type/distribution fields and consume partial
 * fan-out responses. Preserve those contracts; reject malformed supplied values.
 * This checks the wire shape, not whether a decision is true or authorised.
 */
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function probability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validJevAnswers(questions: Record<string, unknown>, answers: unknown): boolean {
  if (!record(answers) || Object.keys(answers).length === 0) return false;
  return Object.entries(answers).every(([id, answer]) => {
    if (!Object.hasOwn(questions, id) || !record(answer)) return false;
    const question = questions[id];
    if (!record(question)) return false;
    if (answer.type !== undefined && answer.type !== question.type) return false;
    if (answer.confidence !== undefined && !probability(answer.confidence)) return false;

    let options: string[];
    if (question.type === "noul") return probability(answer.noul);
    if (question.type === "choice") {
      if (!record(question.criteria) || typeof answer.choice !== "string" ||
          !Object.hasOwn(question.criteria, answer.choice)) return false;
      options = Object.keys(question.criteria);
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 ||
          typeof answer.score !== "number" || !Number.isFinite(answer.score) ||
          answer.score < 0 || answer.score > question.criteria.length - 1) return false;
      options = question.criteria.map((_, i) => String(i));
    } else return false;

    if (answer.probabilities === undefined) return true;
    const distribution = answer.probabilities;
    if (!record(distribution) || Object.keys(distribution).length !== options.length) return false;
    let sum = 0;
    for (const option of options) {
      const value = distribution[option];
      if (!Object.hasOwn(distribution, option) || !probability(value)) return false;
      sum += value;
    }
    // Allow rounding in provider distributions, never arbitrary non-normalised data.
    return Math.abs(sum - 1) <= 0.001;
  });
}
