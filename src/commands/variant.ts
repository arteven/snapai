import { Command, Flags } from "@oclif/core";
import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import sharp from "sharp";
import OpenAI, { toFile } from "openai";
import { ConfigService } from "../services/config.js";
import { ValidationService } from "../utils/validation.js";
import { generateMask, VALID_POSITIONS, Position } from "../utils/mask.js";

export default class VariantCommand extends Command {
  static description =
    "Add something to a specific region of an existing icon using OpenAI image editing";

  static examples = [
    '<%= config.bin %> <%= command.id %> --base ./icon.png --position tl --prompt "add a red notification badge"',
    '<%= config.bin %> <%= command.id %> --base ./icon.png --position "tl tr" --prompt "add sparkles in corners"',
    '<%= config.bin %> <%= command.id %> --base ./icon.png --position tl,tr --prompt "add stars" --output ./out',
    '<%= config.bin %> <%= command.id %> --base ./icon.png --position c --prompt "add a play button" --prompt-only',
  ];

  static flags = {
    base: Flags.string({
      char: "B",
      description: "Path to the base icon PNG",
      required: true,
    }),
    position: Flags.string({
      char: "P",
      description: `One or more position tokens (space/comma separated). Valid: ${VALID_POSITIONS.join(", ")}`,
      required: true,
      multiple: true,
    }),
    prompt: Flags.string({
      char: "p",
      description: "What to add to the specified region",
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
      description:
        'Edit model: "dall-e-2" (strict inpainting, default), "gpt-image-1", or "gpt-image-1.5" (soft guidance, may modify outside zone)',
      default: "dall-e-2",
      options: ["dall-e-2", "gpt-image-1", "gpt-image-1.5"],
    }),
    zone: Flags.integer({
      char: "z",
      description: "Editable zone size as % of canvas (1–100, default 30)",
      default: 30,
      min: 1,
      max: 100,
    }),
    "prompt-only": Flags.boolean({
      description:
        "Preview the final prompt and positions without generating images",
      default: false,
    }),
  };

  private parsePositions(raw: string[]): Position[] {
    const tokens = raw
      .flatMap((v) => v.split(/[\s,]+/))
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);

    const invalid = tokens.filter(
      (t) => !VALID_POSITIONS.includes(t as Position)
    );
    if (invalid.length > 0) {
      this.error(
        chalk.red(
          `Invalid position(s): ${invalid.join(", ")}. Valid: ${VALID_POSITIONS.join(", ")}`
        )
      );
    }

    return [...new Set(tokens)] as Position[];
  }

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
    const { flags } = await this.parse(VariantCommand);

    try {
      // Validate inputs
      const promptError = ValidationService.validatePrompt(flags.prompt);
      if (promptError) this.error(promptError);

      const outputError = ValidationService.validateOutputPath(flags.output);
      if (outputError) this.error(outputError);

      if (!fs.existsSync(flags.base)) {
        this.error(chalk.red(`Base image not found: ${flags.base}`));
      }

      const positions = this.parsePositions(flags.position);

      const apiKeyOverride = flags["openai-api-key"];
      if (apiKeyOverride) {
        const keyError = ValidationService.validateApiKey(apiKeyOverride);
        if (keyError) this.error(chalk.red(keyError));
      }

      if (flags["prompt-only"]) {
        this.log(chalk.blue("🔎 Prompt preview (no generation)"));
        this.log("");
        this.log(chalk.gray(`Base: ${flags.base}`));
        this.log(chalk.gray(`Position(s): ${positions.join(", ")}`));
        this.log(chalk.gray(`Zone: ${flags.zone}% (~${Math.round(1024 * flags.zone / 100)}px)`));
        this.log(chalk.gray(`Model: ${flags.model}`));
        this.log(chalk.gray(`Prompt: ${flags.prompt}`));
        this.log(chalk.gray(`Output directory: ${flags.output}`));
        return;
      }

      this.log(chalk.blue("🎨 Generating icon variant..."));
      this.log("");
      this.log(chalk.gray(`Base: ${flags.base}`));
      this.log(chalk.gray(`Position(s): ${positions.join(", ")}`));
      this.log(chalk.gray(`Zone: ${flags.zone}%`));
      this.log(chalk.gray(`Model: ${flags.model}`));
      this.log(chalk.gray(`Prompt: ${flags.prompt}`));

      // Normalize base image to 1024×1024 RGBA PNG
      this.log(chalk.gray("Normalizing base image to 1024×1024 RGBA..."));
      const imageBuffer = await sharp(flags.base)
        .resize(1024, 1024)
        .ensureAlpha()
        .png()
        .toBuffer();

      // Generate mask
      this.log(chalk.gray("Generating mask..."));
      const maskBuffer = await generateMask(positions, flags.zone);

      // Call OpenAI image edit
      this.log(chalk.gray("Calling OpenAI image edit endpoint..."));
      const client = await this.getClient(apiKeyOverride);

      const imageFile = await toFile(imageBuffer, "image.png", {
        type: "image/png",
      });
      const maskFile = await toFile(maskBuffer, "mask.png", {
        type: "image/png",
      });

      const response = await client.images.edit({
        model: flags.model,
        image: imageFile,
        mask: maskFile,
        prompt: flags.prompt,
        size: "1024x1024",
        n: 1,
        response_format: "b64_json",
      });

      if (!response.data || response.data.length === 0) {
        throw new Error("No image returned from OpenAI");
      }

      const b64 = response.data[0].b64_json;
      if (!b64) {
        throw new Error("No base64 data returned from OpenAI");
      }

      // Save output
      await fs.ensureDir(flags.output);
      const posLabel = positions.join("_");
      const timestamp = Date.now();
      const filename = `variant_${posLabel}_${timestamp}.png`;
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
