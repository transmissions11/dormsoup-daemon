import { DataSource, Email, EmailSender, Event, PrismaClient } from "@prisma/client";
import assert from "assert";
import { convert } from "html-to-text";
import { ImapFlow } from "imapflow";
import { AddressObject, ParsedMail, simpleParser } from "mailparser";

import { authenticate } from "./auth.js";
import { Deferred } from "./deferred.js";
import { CURRENT_MODEL_NAME, extractFromEmail } from "./llm/emailToEvents.js";
import { createEmbedding, removeArtifacts } from "./llm/utils.js";
import { deleteEmbedding, flushEmbeddings, getEmbedding, getKNearestNeighbors, upsertEmbedding } from "./vectordb.js";

export default async function fetchEmailsAndExtractEvents(lookbackDays: number = 60) {
  const auth = await authenticate();
  const client = new ImapFlow({
    host: "outlook.office365.com",
    port: 993,
    secure: true,
    auth,
    logger: false
  });

  const prisma = new PrismaClient();
  await client.connect();

  let lock = await client.getMailboxLock("INBOX");
  try {
    assert(typeof client.mailbox !== "boolean");
    // console.log(`Mailbox has ${client.mailbox.exists} messages`);
    const since = new Date();
    since.setDate(new Date().getDate() - lookbackDays);
    const allUids = await client.search({ since: since }, { uid: true });
    // minUid: what is the earliest email received after `since`?
    const minUid = Math.min(...allUids);
    const byUserAndRecent = {
      scrapedBy: auth.user,
      uid: { gte: minUid }
    };
    console.trace("connected and authenticated");
    // ignoredUids: emails that cannot be dormspams because they don't contain the keywords.
    const ignoredUids = await prisma.ignoredEmail.findMany({
      select: { uid: true },
      where: byUserAndRecent
    });
    console.trace("ignoreUids: ", ignoredUids);
    // processedUids: emails that have been processed by the current model.
    const processedUids = await prisma.email.findMany({
      select: { uid: true },
      where: { ...byUserAndRecent, modelName: { equals: CURRENT_MODEL_NAME } }
    });
    console.trace("processedUids: ", processedUids);

    // seenUids: no need to look at these emails again. saves bandwidth and tokens.
    const seenUids = ignoredUids.concat(processedUids).map((email) => email.uid);
    // const seenUids = processedUids.map((email) => email.uid);
    const uids = allUids.filter((uid) => !seenUids.includes(uid));
    console.log(`Received ${uids.length} unseen mails in the past ${lookbackDays} days.`);
    if (uids.length === 0) return;

    // We need not fetch these processed emails to save bandwidth.
    const fetchedEmails = await prisma.email.findMany({
      where: { ...byUserAndRecent, modelName: { not: CURRENT_MODEL_NAME } },
      include: { sender: true },
      orderBy: { receivedAt: "asc" }
    });
    const fetchedUids = fetchedEmails.map((email) => email.uid);

    const processingTasks = new Map<string, Deferred<void>>();
    const mailProcessors: Promise<ProcessEmailResult>[] = [];

    // Have to ensure the property: For emails A & B, if A.receivedAt <= B.receivedAt, then
    // the promise processMail(..., A) must be created NO LATER THAN processMail(..., B).
    mailProcessors.push(
      ...fetchedEmails.map((email) =>
        processMail(
          prisma,
          auth.user,
          email.uid,
          emailToRelaxedParsedMail(email),
          processingTasks
        ).then((value) => {
          process.stdout.write((value as string).at(-1)!!);
          return value;
        })
      )
    );

    for await (let message of client.fetch(
      uids.filter((uid) => !fetchedUids.includes(uid)),
      { uid: true, envelope: true, source: true },
      { uid: true, changedSince: 0n }
    )) {
      mailProcessors.push(
        simpleParser(message.source)
          .then((parsed) => processMail(prisma, auth.user, message.uid, parsed, processingTasks))
          .then((value) => {
            if (value !== "dormspam-but-root-not-in-db-R")
              process.stdout.write((value as string).at(-1)!!);
            return value;
          })
      );
    }

    const results = await Promise.allSettled(mailProcessors);
    const resultsByType = new Map<ProcessEmailResult, number>();
    for (const result of results) {
      if (result.status === "fulfilled") {
        const x = resultsByType.get(result.value);
        if (x !== undefined) resultsByType.set(result.value, x + 1);
        else resultsByType.set(result.value, 1);
      }
    }
    for (const [key, value] of resultsByType) console.log(`${key}: ${value}`);
  } finally {
    lock.release();
    await prisma.$disconnect();
    await client.logout();
  }
}

type RelaxedParsedMail = Omit<ParsedMail, "attachments" | "headers" | "headerLines" | "from"> & {
  from?: Omit<AddressObject, "html" | "text"> | undefined;
};

// See https://how-to-dormspam.mit.edu/.
const dormspamKeywords = [
  "bcc'd to all dorms",
  "bcc's to all dorms",
  "bcc'd to dorms",
  "bcc'ed dorms",
  "bcc'ed to dorms",
  "bcc to dorms",
  "bcc'd to everyone",
  "bcc dormlists",
  "bcc to dormlists",
  "for bc-talk"
];

const isDormspamRegex = new RegExp(
  dormspamKeywords.map((keyword) => `(${keyword.replaceAll(/ +/g, "\\s+")})`).join("|"),
  "ui"
);

function isDormspam(text: string): boolean {
  return isDormspamRegex.test(text);
}

function emailToRelaxedParsedMail(email: Email & { sender: EmailSender }): RelaxedParsedMail {
  return {
    messageId: email.messageId,
    from: {
      value: [
        {
          address: email.sender.email,
          name: email.sender.name ?? email.sender.email
        }
      ]
    },
    html: email.body,
    subject: email.subject,
    date: email.receivedAt,
    inReplyTo: email.inReplyToId ?? undefined,
    text: convert(email.body)
  };
}

enum ProcessEmailResult {
  MALFORMED_EMAIL = "malformed-email-M",
  NOT_DORMSPAM = "not-dormspam-D",
  DORMSPAM_BUT_ROOT_NOT_IN_DB = "dormspam-but-root-not-in-db-R",
  DORMSPAM_BUT_NOT_EVENT_BY_GPT_3 = "dormspam-but-not-event-by-gpt-3",
  DORMSPAM_BUT_NOT_EVENT_BY_GPT_4 = "dormspam-but-not-event-by-gpt-4",
  DORMSPAM_PROCESSED_WITH_SAME_PROMPT = "dormspam-processed-with-same-prompt-P",
  DORMSPAM_BUT_NETWORK_ERROR = "dormspam-but-network-error-N",
  DORMSPAM_BUT_MALFORMED_JSON = "dormspam-but-malformed-json-J",
  DORMSPAM_WITH_EVENT = "dormspam-with-event-E"
}

async function processMail(
  prisma: PrismaClient,
  scrapedBy: string,
  uid: number,
  parsed: RelaxedParsedMail,
  processingTasks: Map<string, Deferred<void>>
): Promise<ProcessEmailResult> {
  const receivedAt = parsed.date ?? new Date();

  const ignoreThisEmailForever = async () => {
    await prisma.ignoredEmail.upsert({
      where: { scrapedBy_uid: { scrapedBy, uid } },
      create: { scrapedBy, uid, receivedAt },
      update: {}
    });
  };

  const { messageId, from, html, subject } = parsed;
  // This must come before any await, so that this can be synchronously executed once the promise
  // is created.
  const deferred = new Deferred<void>();
  try {
    if (messageId !== undefined) processingTasks.set(messageId, deferred);

    if (
      messageId === undefined ||
      from === undefined ||
      from.value[0].address === undefined ||
      !html ||
      subject === undefined
    ) {
      await ignoreThisEmailForever();
      return ProcessEmailResult.MALFORMED_EMAIL;
    }

    const emailWithSameMessageId = await prisma.email.findUnique({ where: { messageId } });
    if (emailWithSameMessageId !== null && emailWithSameMessageId.uid !== uid) {
      await ignoreThisEmailForever();
      return ProcessEmailResult.MALFORMED_EMAIL;
    }

    const sender = from.value[0];
    const senderAddress = sender.address!!;
    const senderName = sender.name ?? senderAddress;

    const text = removeArtifacts(parsed.text ?? convert(html));
    if (!isDormspam(text)) {
      await ignoreThisEmailForever();
      return ProcessEmailResult.NOT_DORMSPAM;
    }

    let inReplyTo = undefined;
    let rootMessageId = messageId;

    if (parsed.inReplyTo !== undefined) {
      const inReplyToEmail = await prisma.email.findUnique({
        where: { messageId: parsed.inReplyTo }
      });
      if (inReplyToEmail === null) return ProcessEmailResult.DORMSPAM_BUT_ROOT_NOT_IN_DB;
      let root = inReplyToEmail;
      while (root.inReplyToId !== null) {
        const nextRoot = await prisma.email.findUnique({ where: { messageId: root.inReplyToId } });
        if (nextRoot === null) return ProcessEmailResult.DORMSPAM_BUT_ROOT_NOT_IN_DB;
        root = nextRoot;
      }
      rootMessageId = root.messageId;
      inReplyTo = {
        connect: { messageId: parsed.inReplyTo }
      };

      const prevDeferred = processingTasks.get(inReplyToEmail.messageId);
      if (prevDeferred !== undefined) await prevDeferred.promise;
    }

    console.log("\nSubject", subject, "uid", uid);

    await prisma.email.upsert({
      where: { messageId },
      create: {
        messageId,
        scrapedBy,
        uid,
        sender: {
          connectOrCreate: {
            where: { email: senderAddress },
            create: { email: senderAddress, name: senderName }
          }
        },
        subject,
        body: html,
        receivedAt,
        modelName: CURRENT_MODEL_NAME + "_PROCESSING",
        inReplyTo
      },
      update: { modelName: CURRENT_MODEL_NAME + "_PROCESSING" }
    });

    const markProcessedByCurrentModel = async () => {
      await prisma.email.update({ where: { messageId }, data: { modelName: CURRENT_MODEL_NAME } });
    };

    const existing = await prisma.event.findFirst({
      where: { fromEmailId: rootMessageId },
      include: { fromEmail: { select: { modelName: true } } }
    });

    if (existing !== null) {
      // The existing email has already been processed with the current model, do nothing.
      // if (receivedAt < existing.latestUpdateTime) return;
      if (existing.fromEmail?.modelName === CURRENT_MODEL_NAME) {
        await markProcessedByCurrentModel();
        return ProcessEmailResult.DORMSPAM_PROCESSED_WITH_SAME_PROMPT;
      }
      // The existing email has been processed by an older model / prompt. Delete all associated
      // events.
      await prisma.event.deleteMany({ where: { fromEmailId: rootMessageId } });
    }

    const result = await extractFromEmail(subject, text, receivedAt);

    if (result.status === "error-malformed-json")
      return ProcessEmailResult.DORMSPAM_BUT_MALFORMED_JSON;
    if (result.status === "error-openai-network")
      return ProcessEmailResult.DORMSPAM_BUT_NETWORK_ERROR;
    if (result.status === "rejected-by-gpt-3") {
      await markProcessedByCurrentModel();
      return ProcessEmailResult.DORMSPAM_BUT_NOT_EVENT_BY_GPT_3;
    }
    if (result.status === "rejected-by-gpt-4") {
      await markProcessedByCurrentModel();
      return ProcessEmailResult.DORMSPAM_BUT_NOT_EVENT_BY_GPT_4;
    }

    if (result.events.length > 0) console.log(`\nFound events in email: ${parsed.subject}`);
    outer: for (const event of result.events) {
      const embedding = await createEmbedding(event.title);
      upsertEmbedding(event.title, embedding, { eventIds: [] });
      const knn = getKNearestNeighbors(getEmbedding(event.title)!.embeddings, 3);
      const newEventData = {
        date: event.dateTime,
        source: DataSource.DORMSPAM,
        title: event.title,
        location: event.location,
        organizer: event.organizer,
        duration: event.duration,
        fromEmail: { connect: { messageId: rootMessageId } },
        text
      };
      for (const [title, distance] of knn) {
        const { metadata } = getEmbedding(title)!;
        for (const eventId of metadata.eventIds) {
          const otherEvent = (await prisma.event.findUnique({
            where: { id: eventId },
            include: { fromEmail: { select: { receivedAt: true } } }
          }));
          if (otherEvent === null) {
            console.warn("Event id ", eventId, " is in embedding DB metadata but not in DB");
            continue;
          }
          const merged = mergeEvents(
            { ...event, date: event.dateTime, fromEmail: { receivedAt } },
            otherEvent
          );
          if (merged === "latter") {
            console.log("Event ", event, " not inserted because it is merged with ", otherEvent);
            continue outer;
          }
          if (merged === "former") {
            const embedding = await createEmbedding(event.title);
            upsertEmbedding(event.title, embedding, { eventIds: [eventId] });
            metadata.eventIds = metadata.eventIds.filter((id) => id !== eventId);
            if (metadata.eventIds.length === 0) deleteEmbedding(title);
            console.log("Event ", event, " updates previous event ", otherEvent);
            await prisma.event.update({
              where: { id: eventId },
              data: newEventData
            });
            continue outer;
          }
        }
      }
      const newEvent = await prisma.event.create({ data: newEventData });
      upsertEmbedding(event.title, embedding, { eventIds: [newEvent.id] });
      console.log("Event ", event, " inserted ");
    }

    markProcessedByCurrentModel();

    return ProcessEmailResult.DORMSPAM_WITH_EVENT;
  } finally {
    deferred.resolve();
  }
}

function mergeEvents(
  event1: { date: Date; location: string; fromEmail: null | { receivedAt: Date } },
  event2: { date: Date; location: string; fromEmail: null | { receivedAt: Date } }
): "unmergable" | "former" | "latter" {
  const isAllDay = (date: Date) => date.getHours() === 0 && date.getMinutes() === 0;
  const sameDate =
    ((isAllDay(event1.date) || isAllDay(event2.date)) &&
      event1.date.getDay() === event2.date.getDay()) ||
    event1.date.getTime() === event2.date.getTime();
  if (!sameDate) return "unmergable";
  const sameLocation =
    event1.location.toLowerCase() === "unknown" ||
    event2.location.toLowerCase() === "unknown" ||
    event1.location.toLowerCase().includes(event2.location.toLowerCase()) ||
    event2.location.toLowerCase().includes(event1.location.toLowerCase());
  if (!sameLocation) return "unmergable";
  return event1.fromEmail!.receivedAt <= event2.fromEmail!.receivedAt ? "latter" : "former";
}
