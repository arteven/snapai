import { Args, Command, Flags } from "@oclif/core";
import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import sharp from "sharp";
import OpenAI, { toFile } from "openai";
import { ConfigService } from "../services/config.js";
import { ValidationService } from "../utils/validation.js";
import { generateMask, ZoneSpec, Position } from "../utils/mask.js";

// Matches position token followed immediately by a percentage, e.g. t30, tl15, br50
const ZONE_RE = /(tl|tr|bl|br|t|b|l|r|c)(\d+)/gi;

function parseZoneSpecs(raw: string[]): ZoneSpec[] {
  const input = raw.join(" ");
  const specs: ZoneSpec[] = [];
  const regex = new RegExp(ZONE_RE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    specs.push({
      pos: match[1].toLowerCase() as Position,
      percent: Math.max(1, Math.min(100, parseInt(match[2], 10))),
    });
  }
  const leftover = input.replace(new RegExp(ZONE_RE.source, "gi"), "").replace(/\s+/g, "");
  if (leftover) {
    throw new Error(
      `Unrecognized zone token(s): "${leftover}". Format: <position><percent>, e.g. t30, tl15, br50`
    );
  }
  return specs;
}

export default class EditCommand extends Command {
  static description =
    "Edit an existing icon with AI. Optionally restrict edits to specific zones (e.g. t30, tl15br15).";

  static args = {
    base: Args.string({
      description: "Path to the base icon PNG",
      required: true,
    }),
  };

  static examples = [
    '<%= config.bin %> <%= command.id %> ./icon.png --prompt "make it look futuristic"',
    '<%= config.bin %> <%= command.id %> ./icon.png --zone t30 --prompt "add a red notification badge"',
    '<%= config.bin %> <%= command.id %> ./icon.png --zone t30r10 --prompt "add sparkles in corners"',
    '<%= config.bin %> <%= command.id %> ./icon.png --zone tl15 --zone br15 --prompt "add stars in both corners"',
    '<%= config.bin %> <%= command.id %> ./icon.png --zone c40 --prompt "add a play button" --prompt-only',
  ];

  static flags = {
    zone: Flags.string({
      char: "z",
      description:
        "Zone(s) to edit: <position><percent>, e.g. t30 (top 30%), t30r10 (top 30% + right 10%). Omit for whole-image edit. Positions: tl tr bl br t b l r c",
      multiple: true,
    }),
    prompt: Flags.string({
      char: "p",
      description: "What to edit or add",
      required: true,
    }),
    output: Flags.string({
      char: "o",
      description: "Output directory",
      default: "./assets",
    }),
    "openai-api-key": Flags.string({
      char: "k",
      description:
        "OpenAI API key override (does not persist to disk). Also supports SNAPAI_API_KEY / OPENAI_API_KEY",
    }),
    model: Flags.string({
      char: "m",
      description: "Model to use for image editing",
      default: "gpt-image-1.5",
      options: ["gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini", "dall-e-2"],
    }),
    quality: Flags.string({
      char: "q",
      description: "Image quality: auto, low, medium, high",
      default: "auto",
      options: ["auto", "low", "medium", "high"],
    }),
    "prompt-only": Flags.boolean({
      description:
        "Preview the configuration without generating images",
      default: false,
    }),
  };

  private async getClient(apiKeyOverride?: string): Promise<OpenAI> {
    const apiKey =
      apiKeyOverride ||
      process.env.SNAPAI_API_KEY ||
      process.env.OPENAI_API_KEY ||
      (await ConfigService.get("openai_api_key"));

    if (!apiKey) {
      throw new Error(
        "OpenAI API key not configured. Use SNAPAI_API_KEY / OPENAI_API_KEY, or run: snapai config --openai-api-key YOUR_KEY"
      );
    }

    return new OpenAI({ apiKey });
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(EditCommand);

    try {
      const promptError = ValidationService.validatePrompt(flags.prompt);
      if (promptError) this.error(promptError);

      const outputError = ValidationService.validateOutputPath(flags.output);
      if (outputError) this.error(outputError);

      if (!fs.existsSync(args.base)) {
        this.error(chalk.red(`Base image not found: ${args.base}`));
      }

      const apiKeyOverride = flags["openai-api-key"];
      if (apiKeyOverride) {
        const keyError = ValidationService.validateApiKey(apiKeyOverride);
        if (keyError) this.error(chalk.red(keyError));
      }

      const zones: ZoneSpec[] = flags.zone ? parseZoneSpecs(flags.zone) : [];
      const zoneLabel = zones.length
        ? zones.map((z) => `${z.pos}${z.percent}`).join("")
        : "whole";

      if (flags["prompt-only"]) {
        this.log(chalk.blue("🔎 Prompt preview (no generation)"));
        this.log("");
        this.log(chalk.gray(`Base: ${args.base}`));
        this.log(chalk.gray(`Zone(s): ${zones.length ? zoneLabel : "whole image (no mask)"}`));
        this.log(chalk.gray(`Model: ${flags.model}`));
        this.log(chalk.gray(`Quality: ${flags.quality}`));
        this.log(chalk.gray(`Prompt: ${flags.prompt}`));
        this.log(chalk.gray(`Output directory: ${flags.output}`));
        return;
      }

      this.log(chalk.blue("🎨 Generating icon variant..."));
      this.log("");
      this.log(chalk.gray(`Base: ${args.base}`));
      this.log(chalk.gray(`Zone(s): ${zones.length ? zoneLabel : "whole image (no mask)"}`));
      this.log(chalk.gray(`Model: ${flags.model}`));
      this.log(chalk.gray(`Quality: ${flags.quality}`));
      this.log(chalk.gray(`Prompt: ${flags.prompt}`));

      this.log(chalk.gray("Normalizing base image to 1024×1024 RGBA..."));
      const imageBuffer = await sharp(args.base)
        .resize(1024, 1024)
        .ensureAlpha()
        .png()
        .toBuffer();

      const imageFile = await toFile(imageBuffer, "image.png", {
        type: "image/png",
      });

      let maskFile: Awaited<ReturnType<typeof toFile>> | undefined;
      if (zones.length) {
        this.log(chalk.gray("Generating mask..."));
        const maskBuffer = await generateMask(zones);
        maskFile = await toFile(maskBuffer, "mask.png", { type: "image/png" });
      }

      this.log(chalk.gray("Calling OpenAI image edit endpoint..."));
      const client = await this.getClient(apiKeyOverride);

      const response = await client.images.edit({
        model: flags.model,
        image: imageFile,
        ...(maskFile ? { mask: maskFile } : {}),
        prompt: flags.prompt,
        size: "1024x1024",
        quality: flags.quality as "auto" | "low" | "medium" | "high",
        n: 1,
      });

      if (!response.data || response.data.length === 0) {
        throw new Error("No image returned from OpenAI");
      }

      const b64 = response.data[0].b64_json;
      if (!b64) {
        throw new Error("No base64 data returned from OpenAI");
      }

      await fs.ensureDir(flags.output);
      const timestamp = Date.now();
      const filename = `edit_${zoneLabel}_${timestamp}.png`;
      const outputPath = path.join(flags.output, filename);
      await fs.writeFile(outputPath, Buffer.from(b64, "base64"));

      this.log(chalk.green("✅ Variant generated successfully!"));
      this.log(chalk.gray(`Saved to: ${outputPath}`));
    } catch (error) {
      this.error(
        chalk.red(`Failed to generate variant: ${(error as Error).message}`)
      );
    }
  }
}
