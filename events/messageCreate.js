import { promises } from "fs";
import database from "../utils/database.js";
import { log, error as _error } from "../utils/logger.js";
import { prefixCache, aliases, disabledCache, disabledCmdCache, commands } from "../utils/collections.js";
import parseCommand from "../utils/parseCommand.js";
import { clean } from "../utils/misc.js";
import fetch from "node-fetch";
import FormData from "form-data";

const uploadToServer = async file => {  
  const uploadKey = process.env.UPLOAD_SYSTEMS_KEY;
  const form = new FormData();
  
  if (uploadKey == "") {
    return "";
  }

  form.append("file", file, {
    contentType: "image/gif",
    name: "file",
    filename: "image.gif",
  });

  form.append("key", uploadKey);

  log("info", file);
  const response = await fetch("https://api.upload.systems/images/upload", {
    method: "POST",
    body: form,
  });

  const text = await response.text();
  log("info", text);

  if (response.ok) {
    try {
      const data = JSON.parse(text);
      return data.cdnUrl;
    } catch {
      log("error", `Couldn't deserialise response from upload server ${text}`);
      return "";
    }
  } else {
    log("error", `Request failed ${response.status}`);
    log("error", text);

    return "";
  }
};

// run when someone sends a message
export default async (client, cluster, worker, ipc, message) => {
  // ignore other bots
  if (message.author.bot) return;

  // don't run command if bot can't send messages
  if (message.channel.guild && !message.channel.permissionsOf(client.user.id).has("sendMessages")) return;

  let prefixCandidate;
  let guildDB;
  if (message.channel.guild) {
    const cachedPrefix = prefixCache.get(message.channel.guild.id);
    if (cachedPrefix) {
      prefixCandidate = cachedPrefix;
    } else {
      guildDB = await database.getGuild(message.channel.guild.id);
      if (!guildDB) {
        guildDB = await database.fixGuild(message.channel.guild);
      }
      prefixCandidate = guildDB.prefix;
      prefixCache.set(message.channel.guild.id, guildDB.prefix);
    }
  }

  let prefix;
  let isMention = false;
  if (message.channel.guild) {
    const user = message.channel.guild.members.get(client.user.id);
    if (message.content.startsWith(user.mention)) {
      prefix = `${user.mention} `;
      isMention = true;
    } else if (message.content.startsWith(`<@${client.user.id}>`)) { // workaround for member.mention not accounting for both mention types
      prefix = `<@${client.user.id}> `;
      isMention = true;
    } else {
      prefix = prefixCandidate;
    }
  } else {
    prefix = "";
  }

  // ignore other stuff
  if (!message.content.startsWith(prefix)) return;

  // separate commands and args
  const replace = isMention ? `@${client.user.username} ` : prefix;
  const content = message.cleanContent.substring(replace.length).trim();
  const rawContent = message.content.substring(prefix.length).trim();
  const preArgs = content.split(/\s+/g);
  preArgs.shift();
  const command = rawContent.split(/\s+/g).shift().toLowerCase();
  const parsed = parseCommand(preArgs);
  const aliased = aliases.get(command);

  // don't run if message is in a disabled channel
  if (message.channel.guild) {
    const disabled = disabledCache.get(message.channel.guild.id);
    if (disabled) {
      if (disabled.includes(message.channel.id) && command != "channel") return;
    } else {
      guildDB = await database.getGuild(message.channel.guild.id);
      disabledCache.set(message.channel.guild.id, guildDB.disabled);
      if (guildDB.disabled.includes(message.channel.id) && command !== "channel") return;
    }

    const disabledCmds = disabledCmdCache.get(message.channel.guild.id);
    if (disabledCmds) {
      if (disabledCmds.includes(aliased ? aliased : command)) return;
    } else {
      guildDB = await database.getGuild(message.channel.guild.id);
      disabledCmdCache.set(message.channel.guild.id, guildDB.disabled_commands ? guildDB.disabled_commands : guildDB.disabledCommands);
      if ((guildDB.disabled_commands ? guildDB.disabled_commands : guildDB.disabledCommands).includes(aliased ? aliased : command)) return;
    }
  }

  // check if command exists and if it's enabled
  const cmd = aliased ? commands.get(aliased) : commands.get(command);
  if (!cmd) return;

  // actually run the command
  log("log", `${message.author.username} (${message.author.id}) ran command ${command}`);
  const reference = {
    messageReference: {
      channelID: message.channel.id,
      messageID: message.id,
      guildID: message.channel.guild ? message.channel.guild.id : undefined,
      failIfNotExists: false
    },
    allowedMentions: {
      repliedUser: false
    }
  };
  try {
    await database.addCount(aliases.has(command) ? aliases.get(command) : command);
    const startTime = new Date();
    // eslint-disable-next-line no-unused-vars
    const commandClass = new cmd(client, cluster, worker, ipc, message, parsed._, message.content.substring(prefix.length).trim().replace(command, "").trim(), (({ _, ...o }) => o)(parsed)); // we also provide the message content as a parameter for cases where we need more accuracy
    const result = await commandClass.run();
    const endTime = new Date();
    if ((endTime - startTime) >= 180000) reference.allowedMentions.repliedUser = true;
    if (typeof result === "string") {
      reference.allowedMentions.repliedUser = true;
      await client.createMessage(message.channel.id, Object.assign({
        content: result
      }, reference));
    } else if (typeof result === "object" && result.embed) {
      await client.createMessage(message.channel.id, Object.assign(result, reference));
    } else if (typeof result === "object" && result.file) {
      if (result.file.length > 8388119 && process.env.TEMPDIR !== "") {
        const imageURL = await uploadToServer(result.file);
        if (imageURL == "") {
          await client.createMessage(message.channel.id, Object.assign({
            embed: {
              color: 16711680,
              title: "Upload failed",
              content: "The image was larger than 8MB and had to be uploaded to an external service, but this failed."
            }
          }, reference));
        }

        await client.createMessage(message.channel.id, Object.assign({
          embed: {
            color: 16711680,
            title: "Here's your image!",
            url: imageURL,
            image: {
              url: imageURL
            },
            footer: {
              text: "The result image was more than 8MB in size, so it was uploaded to an external site instead."
            },
          }
        }, reference));
      } else {
        await client.createMessage(message.channel.id, Object.assign({
          content: result.text ? result.text : undefined
        }, reference), result);
      }
    }
  } catch (error) {
    if (error.toString().includes("Request entity too large")) {
      await client.createMessage(message.channel.id, Object.assign({
        content: "The resulting file was too large to upload. Try again with a smaller image if possible."
      }, reference));
    } else if (error.toString().includes("Job ended prematurely")) {
      await client.createMessage(message.channel.id, Object.assign({
        content: "Something happened to the image servers before I could receive the image. Try running your command again."
      }, reference));
    } else if (error.toString().includes("Timed out")) {
      await client.createMessage(message.channel.id, Object.assign({
        content: "The request timed out before I could download that image. Try uploading your image somewhere else or reducing its size."
      }, reference));
    } else {
      _error(`Error occurred with command message ${message.cleanContent}: ${error.toString()}`);
      try {
        await client.createMessage(message.channel.id, Object.assign({
          content: "Uh oh! I ran into an error while running this command. Please report the content of the attached file at the following link or on the esmBot Support server: <https://github.com/esmBot/esmBot/issues>"
        }, reference), [{
          file: `Message: ${await clean(error)}\n\nStack Trace: ${await clean(error.stack)}`,
          name: "error.txt"
        }]);
      } catch { /* silently ignore */ }
    }
  }
};
