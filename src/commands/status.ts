import { encode } from "@toon-format/toon";
import { tgRequest, type TgRequestContext } from "../tg.js";
import {
  field,
  renderDetail,
  renderHelp,
  renderOutput,
} from "../toon.js";
import { requireToken, type TgContext } from "../context.js";

export const STATUS_HELP = `usage: tg-axi status
Run a getMe/getChat health check against the Telegram Bot API.

flags[1]:
  --chat <id> (default 123456789) selects the chat for getChat
examples:
  tg-axi status
  tg-axi status --chat 123456789
`;

interface TgBot {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
}

interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

const botSchema = [
  field("id"),
  field("username"),
  field("first_name"),
  { type: "boolYesNo", key: "is_bot", as: "is_bot" } as const,
  { type: "boolYesNo", key: "can_join_groups", as: "can_join_groups" } as const,
  { type: "boolYesNo", key: "can_read_all_group_messages", as: "reads_all_group_msgs" } as const,
];

const chatSchema = [
  field("id"),
  field("type"),
  field("title"),
  field("username"),
  field("first_name"),
];

/** getMe + getChat health check. Throws AUTH_REQUIRED if no token is loadable. */
export async function statusCommand(args: string[], ctx: TgContext): Promise<string> {
  if (args[0] === "--help") return STATUS_HELP;
  const apiCtx: TgRequestContext = requireToken(ctx);
  const me = await tgRequest<TgBot>("getMe", {}, apiCtx);
  let chat: TgChat | null = null;
  let chatError: string | undefined;
  try {
    chat = await tgRequest<TgChat>("getChat", { chat_id: apiCtx.chatId }, apiCtx);
  } catch (error) {
    chatError = error instanceof Error ? error.message : String(error);
  }
  const blocks: (string | undefined)[] = [
    renderDetail("bot", me, botSchema as never),
  ];
  if (chat) {
    blocks.push(renderDetail("chat", chat, chatSchema as never));
  } else {
    blocks.push(
      encode({
        chat: "unreachable",
        chat_id: apiCtx.chatId,
        error: chatError ?? "unknown",
      }),
    );
  }
  blocks.push(renderHelp(statusHints(apiCtx.chatId, chat)));
  return renderOutput(blocks);
}

function statusHints(chatId: string, chat: TgChat | null): string[] {
  const hints: string[] = [`Run \`tg-axi send --stdin --title "<alert>"\` to send a test message`];
  if (!chat) {
    hints.push(`Chat ${chatId} is unreachable — start a conversation with the bot first`);
  }
  hints.push("Run `tg-axi` for the session digest");
  return hints;
}
