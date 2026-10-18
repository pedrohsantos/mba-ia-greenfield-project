const mailpitUrl = `http://${process.env.MAIL_HOST ?? 'mailpit'}:8025`;

export interface MailpitAddress {
  Name: string;
  Address: string;
}

/** Message summary as returned by Mailpit's `GET /api/v1/messages`. */
export interface MailpitMessageSummary {
  ID: string;
  Subject: string;
  From: MailpitAddress;
  To: MailpitAddress[];
}

/** Full message as returned by Mailpit's `GET /api/v1/message/{id}`. */
export interface MailpitMessage extends MailpitMessageSummary {
  HTML: string;
  Text: string;
}

export async function getMailpitMessages(): Promise<MailpitMessageSummary[]> {
  const res = await fetch(`${mailpitUrl}/api/v1/messages`);
  const data = (await res.json()) as { messages?: MailpitMessageSummary[] };
  return data.messages ?? [];
}

export async function getMailpitMessage(id: string): Promise<MailpitMessage> {
  const res = await fetch(`${mailpitUrl}/api/v1/message/${id}`);
  return (await res.json()) as MailpitMessage;
}

export async function clearMailpitMessages(): Promise<void> {
  await fetch(`${mailpitUrl}/api/v1/messages`, { method: 'DELETE' });
}
