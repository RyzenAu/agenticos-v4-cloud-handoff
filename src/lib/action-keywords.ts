/**
 * The ONE list of words that mean "this reaches other people, spends money, publishes, installs or
 * destroys data". Two gates are built from it, so a new verb is added once, here, not twice:
 *
 * - TASK_GATE: a spoken control_pc task ("email Brooke the draft") needs his spoken yes
 *   (`needsConfirmation` in jarvis-control.ts, and the control_pc risk tier in control-risk.ts).
 * - FINAL_BUTTON: a button label on his screen ("Place order") is a final press that needs his yes
 *   (`vetAction` in scripts/screen-hands/plan.ts).
 *
 * Before 27 Sep these were two separate regexes (OUTBOUND in jarvis-control.ts, FINAL_BUTTON in
 * plan.ts) that had drifted apart. `scripts/action-keywords.test.ts` keeps both old lists verbatim
 * and proves every one of their entries is still covered.
 *
 * Scopes exist because a word can be safe in one place and not the other: "Format" is a harmless
 * ribbon button but "format the D: drive" is not; "Finish" on a wizard is final but "finish the
 * essay" is not. Default to BOTH scopes; narrow one only with a reason in `why`.
 */

export type KeywordScope = "task" | "button";
export type KeywordCategory =
  | "communication" // reaches another person
  | "publishing" // makes something public
  | "money" // spends, moves or asks for money
  | "commitment" // books, signs up, accepts terms
  | "destructive" // deletes or wipes data
  | "software" // installs, removes or deploys code
  | "account"; // sign-out, saved passwords

export type ActionKeyword = {
  /** Stable name for tests and audit reasons. */
  id: string;
  category: KeywordCategory;
  /** A regex fragment. Word boundaries are added around it unless `bounded` is false. */
  pattern: string;
  scopes: readonly KeywordScope[];
  /** Why an entry is limited to one scope. */
  why?: string;
  /** false: the fragment carries its own boundaries (used for "text <someone>"). */
  bounded?: boolean;
};

const BOTH = ["task", "button"] as const;
const TASK = ["task"] as const;
const BUTTON = ["button"] as const;

export const ACTION_KEYWORDS: readonly ActionKeyword[] = [
  // --- communication -------------------------------------------------------------------------
  { id: "send", category: "communication", pattern: "send", scopes: BOTH },
  { id: "sent", category: "communication", pattern: "sent", scopes: TASK, why: "a 'Sent' folder or label is not a send button" },
  { id: "email", category: "communication", pattern: "e-?mail", scopes: TASK, why: "an 'Email' field or link only opens a composer" },
  { id: "mail-someone", category: "communication", pattern: "mail\\s+(?!app|client|folder)", scopes: TASK, why: "task phrasing ('mail Sam the file')" },
  { id: "message", category: "communication", pattern: "message", scopes: TASK, why: "a 'Message' button opens a chat, it doesn't send" },
  { id: "whatsapp", category: "communication", pattern: "whatsapp", scopes: TASK, why: "an app name, not a button action" },
  { id: "sms", category: "communication", pattern: "sms", scopes: TASK, why: "task phrasing" },
  { id: "dm", category: "communication", pattern: "dm", scopes: TASK, why: "task phrasing" },
  { id: "reply", category: "communication", pattern: "reply", scopes: TASK, why: "a 'Reply' button only opens the reply box; Send is the final press" },
  { id: "respond-to", category: "communication", pattern: "respond\\s+to", scopes: TASK, why: "task phrasing" },
  {
    id: "text-someone",
    category: "communication",
    pattern: "\\btext\\s+(?!file|files|document|editor|box|field)\\w+",
    scopes: TASK,
    bounded: false,
    why: "'text Mehroz' is a message; a 'Text' button or text box is not",
  },
  { id: "invite", category: "communication", pattern: "invite", scopes: BOTH },
  { id: "rsvp", category: "communication", pattern: "rsvp", scopes: BOTH },
  { id: "share", category: "communication", pattern: "share", scopes: BOTH },
  // --- publishing ----------------------------------------------------------------------------
  { id: "post", category: "publishing", pattern: "post", scopes: BOTH },
  { id: "publish", category: "publishing", pattern: "publish", scopes: BOTH },
  { id: "tweet", category: "publishing", pattern: "tweet", scopes: BOTH },
  { id: "upload", category: "publishing", pattern: "upload", scopes: BOTH },
  { id: "submit", category: "publishing", pattern: "submit", scopes: BOTH },
  // --- money ---------------------------------------------------------------------------------
  { id: "pay", category: "money", pattern: "pay|pay now", scopes: BOTH },
  { id: "payment", category: "money", pattern: "payment", scopes: TASK, why: "'Payment' tabs and headings are not a press that pays" },
  { id: "buy", category: "money", pattern: "buy", scopes: BOTH },
  { id: "purchase", category: "money", pattern: "purchase", scopes: BOTH },
  { id: "order-task", category: "money", pattern: "order\\s+(?!by|them|these|the\\s+files)", scopes: TASK, why: "'order these files by date' is sorting" },
  { id: "order-button", category: "money", pattern: "place (?:my )?order|order now", scopes: BUTTON, why: "a bare 'Order' column header is sorting" },
  { id: "checkout-task", category: "money", pattern: "checkout", scopes: TASK, why: "'check out this video' is not a purchase" },
  { id: "checkout-button", category: "money", pattern: "check ?out", scopes: BUTTON, why: "on a button, 'Check out' is the purchase step" },
  { id: "transfer", category: "money", pattern: "transfer", scopes: BOTH },
  { id: "wire", category: "money", pattern: "wire", scopes: TASK, why: "task phrasing ('wire $500 to…')" },
  { id: "refund", category: "money", pattern: "refund", scopes: BOTH },
  { id: "donate", category: "money", pattern: "donate", scopes: BOTH },
  { id: "withdraw", category: "money", pattern: "withdraw", scopes: BOTH },
  { id: "deposit", category: "money", pattern: "deposit", scopes: BOTH },
  // --- commitments ---------------------------------------------------------------------------
  { id: "book-task", category: "commitment", pattern: "book", scopes: TASK, why: "'book' as a verb; a 'Book' label can be a title" },
  { id: "book-button", category: "commitment", pattern: "book(?: now)?", scopes: BUTTON, why: "button labels: Book, Book now" },
  { id: "schedule", category: "commitment", pattern: "schedule", scopes: TASK, why: "'Schedule' tabs and headings are common and harmless on screen" },
  { id: "reserve", category: "commitment", pattern: "reserve", scopes: BOTH },
  { id: "sign-up", category: "commitment", pattern: "sign ?up", scopes: BOTH },
  { id: "register", category: "commitment", pattern: "register", scopes: BOTH },
  { id: "subscribe", category: "commitment", pattern: "subscribe", scopes: BOTH },
  { id: "unsubscribe", category: "commitment", pattern: "unsubscribe", scopes: BOTH },
  { id: "confirm", category: "commitment", pattern: "confirm", scopes: BUTTON, why: "'confirm the file exists' is a check, not a commitment" },
  { id: "accept", category: "commitment", pattern: "accept", scopes: BUTTON, why: "on a button it agrees to terms; in a task it's too generic" },
  { id: "agree", category: "commitment", pattern: "agree", scopes: BUTTON, why: "as above" },
  { id: "apply", category: "commitment", pattern: "apply", scopes: BUTTON, why: "'apply a filter' in a task is harmless; an Apply button commits" },
  { id: "finish", category: "commitment", pattern: "finish", scopes: BUTTON, why: "'finish the essay' is not a final press" },
  { id: "complete", category: "commitment", pattern: "complete", scopes: BUTTON, why: "as above" },
  {
    id: "cancel-task",
    category: "commitment",
    pattern: "cancel\\s+(?:my|the|his|her)\\s+\\w*\\s*(?:subscription|order|booking|meeting|appointment)",
    scopes: TASK,
    why: "task phrasing ('cancel my Netflix subscription')",
  },
  {
    id: "cancel-button",
    category: "commitment",
    pattern: "cancel (?:my )?(?:order|subscription|booking|account|plan)",
    scopes: BUTTON,
    why: "a bare 'Cancel' button just closes a dialog",
  },
  // --- destructive ---------------------------------------------------------------------------
  { id: "delete", category: "destructive", pattern: "delete", scopes: BOTH },
  { id: "remove", category: "destructive", pattern: "remove", scopes: BOTH },
  { id: "erase", category: "destructive", pattern: "erase", scopes: BOTH },
  { id: "wipe", category: "destructive", pattern: "wipe|factory reset|reset (?:this )?(?:pc|device|phone|computer)", scopes: BOTH },
  { id: "format", category: "destructive", pattern: "format", scopes: TASK, why: "the 'Format' ribbon button is harmless" },
  // 27 Sep night (review REVIEW-JEV finding 2): labels the old gate let Jev press alone.
  { id: "trash", category: "destructive", pattern: "trash|move to (?:the )?(?:recycle )?bin|bin it", scopes: BOTH },
  { id: "empty", category: "destructive", pattern: "empty", scopes: BUTTON, why: "'Empty Recycle Bin', 'Empty Trash', 'Empty folder'; the task phrasing is control-risk's 'empties or clears data'" },
  { id: "discard", category: "destructive", pattern: "discard", scopes: BUTTON, why: "the Discard press is the gated step (a spoken 'discard my changes' is already external: control-risk fails closed on it)" },
  // REVIEW-SAFETY §2: data loss, OAuth grants and other irreversible labels the gate still missed.
  { id: "dont-save", category: "destructive", pattern: "don'?t save|do not save|close without saving|exit without saving|lose changes", scopes: BUTTON, why: "unsaved work is lost" },
  { id: "force-push", category: "destructive", pattern: "force push|force-push|reset (?:to|hard|all|everything|settings|defaults|password|account)|reset", scopes: BUTTON, why: "'Reset' on screen is usually irreversible; as a task, control-risk classifies it" },
  { id: "grant", category: "account", pattern: "authori[sz]e|grant (?:access|permission|permissions)|allow access|give access", scopes: BUTTON, why: "an OAuth or permission grant" },
  { id: "leave-block", category: "communication", pattern: "leave (?:group|team|workspace|channel|server|chat|conversation)|block(?: user| contact| number)?|report (?:user|spam)", scopes: BUTTON, why: "affects other people or can't easily be undone" },
  { id: "overwrite", category: "destructive", pattern: "overwrite|replace (?:it|file|the file|existing|all)", scopes: BUTTON, why: "'Replace the file in the destination', 'Overwrite'; a bare 'Replace' in Find is harmless" },
  // --- software ------------------------------------------------------------------------------
  { id: "install", category: "software", pattern: "install", scopes: BOTH },
  { id: "uninstall", category: "software", pattern: "uninstall", scopes: BOTH },
  { id: "deploy", category: "software", pattern: "deploy", scopes: BOTH },
  { id: "push", category: "software", pattern: "push", scopes: TASK, why: "'push' on screen is too generic ('Push notifications' settings)" },
  { id: "merge", category: "software", pattern: "merge", scopes: BOTH },
  { id: "commit", category: "software", pattern: "commit(?: changes| directly)?", scopes: BUTTON, why: "GitHub's web 'Commit changes' writes to the repository; the task phrasing is control-risk's 'network transfer'" },
  { id: "approve", category: "commitment", pattern: "approve|approval", scopes: BOTH },
  // --- account -------------------------------------------------------------------------------
  { id: "log-out", category: "account", pattern: "log ?out", scopes: BUTTON, why: "on screen only; 'log out of Chrome' as a task is local" },
  { id: "sign-out", category: "account", pattern: "sign ?out", scopes: BUTTON, why: "as above" },
  { id: "save-password", category: "account", pattern: "save password", scopes: BUTTON, why: "the browser's save-password prompt" },
  {
    id: "account-change",
    category: "account",
    pattern:
      "(?:change|reset|update|set) (?:your |my |the |a )?(?:new )?(?:password|passcode|pin|email(?: address)?|phone number|username|recovery (?:email|phone))|close (?:my |your |the )?account|delete (?:my |your |the )?account|deactivate|revoke|disable (?:two[- ]factor|2fa|mfa|two[- ]step)|remove (?:this )?(?:account|device)",
    scopes: BOTH,
  },
  // --- the same final presses in other languages (REVIEW-S2C fix 2) --------------------------------
  // Send, submit, delete, post, publish and confirm on a button, in French, German, Spanish, Italian,
  // Portuguese, Dutch, Arabic, Chinese, Japanese, Korean, Hindi and Urdu. Button scope only: these are what
  // a page shows, and the spoken task gate stays English (speech-to-text runs in English). Kept to the
  // unambiguous verbs: no "OK"/"確認"/"확인" (every dialog has one), no "cancel", no "apagar" (also "turn off"), no "valider"; "effacer"/"borrar" before a filter or search is not final (REVIEW-S2C R2).
  {
    id: "final-latin-languages",
    category: "communication",
    pattern:
      "(?<![a-zà-ÿœ])(?:envoyer|envoi|soumettre|supprimer|effacer(?! (?:les? |la )?(?:filtres?|recherche))|publier|confirmer|senden|absenden|abschicken|l[öo]schen|entfernen|ver[öo]ffentlichen|posten|best[äa]tigen|enviar|eliminar|borrar(?! (?:el |la |los |las )?(?:filtros?|b[uú]squeda))|publicar|confirmar|invia|inviare|elimina|eliminare|pubblica|pubblicare|conferma|confermare|excluir|verzenden|versturen|verwijderen|publiceren|bevestigen)(?![a-zà-ÿœ])",
    scopes: BUTTON,
    bounded: false,
    why: "on-screen labels in other languages; the spoken task gate is English",
  },
  {
    id: "final-other-scripts",
    category: "communication",
    pattern:
      "إرسال|ارسال|أرسل|حذف|نشر|تأكيد|发送|發送|提交|删除|刪除|发布|發布|發佈|确认|送信|送る|削除|投稿|確定|보내기|전송|제출|삭제|(?:^|\\s)게시(?:하기)?(?:$|\\s)|भेजें|भेजो|भेजना|सबमिट|हटाएं|हटाएँ|मिटाएं|प्रकाशित|पुष्टि|بھیجیں|بھیجو|شائع|مٹائیں|تصدیق|جمع کرائیں",
    scopes: BUTTON,
    bounded: false,
    why: "on-screen labels in Arabic, Chinese, Japanese, Korean, Hindi and Urdu scripts",
  },
  {
    id: "final-cyrillic",
    category: "communication",
    pattern: "(?<![а-яё])(?:отправить|удалить|оплатить|подтвердить|купить|опубликовать)(?![а-яё])",
    scopes: BUTTON,
    bounded: false,
    why: "on-screen labels in Russian: send, delete, pay, confirm, buy, publish (REVIEW-S2C R4)",
  },
];

function build(scope: KeywordScope) {
  const parts = ACTION_KEYWORDS.filter((k) => k.scopes.includes(scope)).map((k) => (k.bounded === false ? `(?:${k.pattern})` : `\\b(?:${k.pattern})\\b`));
  return new RegExp(parts.join("|"), "i");
}

/** A spoken task with an external effect: needs his spoken yes before control_pc runs it. */
export const TASK_GATE = build("task");
/** A final, consequential button: pressing it needs his spoken yes. */
export const FINAL_BUTTON = build("button");

/** Which catalogue entries a text trips, in one scope (for reasons and the audit log). */
export function matchKeywords(text: string, scope: KeywordScope): ActionKeyword[] {
  return ACTION_KEYWORDS.filter(
    (k) => k.scopes.includes(scope) && new RegExp(k.bounded === false ? k.pattern : `\\b(?:${k.pattern})\\b`, "i").test(text),
  );
}
