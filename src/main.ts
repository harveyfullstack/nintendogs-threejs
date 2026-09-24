const params = new URLSearchParams(location.search);
const tests = import.meta.glob('./tests/*.ts');
if (params.has('viewer')) {
  import('./viewer').then((m) => m.startViewer(params));
} else if (params.has('test')) {
  const key = `./tests/${params.get('test')}.ts`;
  const load = tests[key];
  if (!load) document.body.textContent = 'No test page ' + key + '. Available: ' + Object.keys(tests).join(', ');
  else load().then((m: any) => m.default ? m.default(params) : m.run(params));
} else {
  import('./game/boot').then((m) => m.boot()).catch((e) => {
    console.error(e);
    document.body.textContent = "Sorry, the game couldn't load. Check your connection and reload the page.";
  });
}
