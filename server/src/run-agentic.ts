import { agenticResearchStream } from './engine.js';

async function run() {
  console.log("Starting agentic research stream test...");
  await agenticResearchStream('What is the weather in Paris?', [], (ev) => {
    if (ev.type === 'step') {
      console.log(`[Step - ${ev.data.type}] ${ev.data.note || ev.data.query || ''}`);
    } else if (ev.type === 'error') {
      console.error(`[Error] ${ev.message}`);
    }
  }, 'quick');
  console.log("Finished agentic research stream test.");
}

run();
