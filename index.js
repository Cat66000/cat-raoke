import {init} from "./built/init.js";
import { fileURLToPath } from 'url'
import { dirname } from 'path'
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

process.chdir(__dirname)

await init();