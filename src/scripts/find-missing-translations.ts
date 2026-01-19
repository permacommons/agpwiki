import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';

const localesDir = path.resolve(process.cwd(), 'locales/ui');

function flattenKeys(obj: Record<string, unknown>, prefix = ''): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const subKeys = flattenKeys(value as Record<string, unknown>, newKey);
      for (const subKey of subKeys) {
        keys.add(subKey);
      }
    } else {
      keys.add(newKey);
    }
  }
  return keys;
}

function main() {
  const enPath = path.join(localesDir, 'en.json5');
  if (!fs.existsSync(enPath)) {
    console.error('Error: locales/ui/en.json5 not found.');
    process.exit(1);
  }

  const enContent = fs.readFileSync(enPath, 'utf-8');
  const enObj = JSON5.parse(enContent);
  const canonicalKeys = flattenKeys(enObj);

  const files = fs.readdirSync(localesDir).filter(f => f.endsWith('.json5') && f !== 'en.json5');

  for (const file of files) {
    const langCode = path.basename(file, '.json5');
    const filePath = path.join(localesDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    
    try {
      const obj = JSON5.parse(content);
      const existingKeys = flattenKeys(obj);
      
      for (const key of canonicalKeys) {
        if (!existingKeys.has(key)) {
          console.log(`${langCode},${key}`);
        }
      }
    } catch (error) {
      console.error(`Error parsing ${file}:`, error);
    }
  }
}

main();
