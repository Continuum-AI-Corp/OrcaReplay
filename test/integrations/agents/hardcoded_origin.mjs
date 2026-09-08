/**
 * A JS agent with its origin compiled in, which no environment variable can reach.
 *
 * This is the case the fetch hook exists for — the Vercel AI SDK takes its origin as a constructor
 * argument and reads nothing from the environment, and so does anything that types a URL into its
 * own source.
 */
const res = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer stub' },
  body: JSON.stringify({ model: 'stub-1', messages: [{ role: 'user', content: 'hello' }] }),
});
const doc = await res.json();
console.log('GOT:', doc.choices[0].message.content);
