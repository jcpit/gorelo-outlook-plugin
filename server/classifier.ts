import type { GoreloOptions, Option } from "./goreloConnector.js";

const ENDPOINT = "https://opencode.ai/zen/v1/systemone";
const MODEL = "jev-1.13-free";
const MIN_CONFIDENCE = 0.6;

const descriptions: Record<string, string> = {
  "everyone": "General catch-all team when no specialist team fits.",
  "accounts": "Billing, payments, invoices, and accounts administration.",
  "internal tasks": "Work internal to the service provider, not client-facing support.",
  "domain renewals": "Domain name renewals, registration and expiry.",
  "it support": "End-user IT support, devices, applications, connectivity and troubleshooting.",
  "security team": "Security incidents, suspicious activity, access risk and security reviews.",
  "hosting": "Hosted services, websites, hosting infrastructure and hosting outages.",
  "incident": "Something is broken, degraded or not working as expected.",
  "request": "A request for help, access, information or a standard service; nothing is broken.",
  "proactive": "Planned preventative work initiated ahead of a failure.",
  "internal": "Internal administrative work, not a customer support request.",
  "unknown": "Not enough information to determine a ticket type.",
  "project": "Work belonging to a scoped multi-step project.",
  "change": "A planned change to a system or configuration.",
  "problem": "Investigation into the underlying cause of recurring incidents.",
  "maintenance": "Scheduled upkeep, patching or maintenance.",
  "security": "Security concern, vulnerability, phishing or compromised account.",
  "communication": "Informational update or notice without a specific service request.",
};

function criteria(options: Option[]): Record<string, string> {
  return Object.fromEntries(options.map(({ id, name }) => [
    `id_${id}`, `${name}: ${descriptions[name.trim().toLowerCase()] || `Gorelo category named ${name}.`}`,
  ]));
}

function recommendation(answer: unknown, options: Option[]): { id: number; confidence: number } | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const { type, choice, confidence } = answer as Record<string, unknown>;
  if (type !== "choice" || typeof choice !== "string" ||
    typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || confidence > 1) return undefined;
  const option = options.find(({ id }) => choice === `id_${id}`);
  return option ? { id: option.id, confidence } : undefined;
}

export async function classifyTicket(
  apiKey: string, subject: string, bodyText: string, options: Pick<GoreloOptions, "groups" | "types">,
): Promise<{ team?: { id: number; confidence: number }; type?: { id: number; confidence: number } }> {
  if (!options.groups.length || !options.types.length) return {};
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        state: `Email subject: ${subject.slice(0, 250)}\nEmail message: ${bodyText.slice(0, 2500)}`,
        questions: {
          team: { type: "choice", instructions: "Which Gorelo team should own this support ticket? Choose based on the email's actual request, not its recipients. If unclear, choose the general team.", criteria: criteria(options.groups) },
          ticket_type: { type: "choice", instructions: "What kind of ticket does this email describe? Distinguish a broken service (incident) from a new service request. If unclear choose Unknown when available.", criteria: criteria(options.types) },
        },
      }),
    });
  } catch {
    throw new Error("Jev could not be reached. Select Team and Type manually.");
  }
  if (!response.ok) throw new Error(`Jev request failed (HTTP ${response.status}). Select Team and Type manually.`);
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error("Jev returned an invalid response. Select Team and Type manually."); }
  const answers = result && typeof result === "object" ? (result as Record<string, unknown>).answers : undefined;
  if (!answers || typeof answers !== "object") throw new Error("Jev returned no classifications. Select Team and Type manually.");
  const { team, ticket_type: ticketType } = answers as Record<string, unknown>;
  const matchedTeam = recommendation(team, options.groups);
  const matchedType = recommendation(ticketType, options.types);
  return {
    ...(matchedTeam ? { team: matchedTeam } : {}),
    ...(matchedType ? { type: matchedType } : {}),
  };
}
