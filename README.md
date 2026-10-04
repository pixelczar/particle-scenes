# particle-scenes

A ring, a number and a typing indicator made of particles that morph into each other. Built with three.js, with live dials from [DialKit](https://github.com/joshpuckett/dialkit).

```bash
npm install
npm run dev
```

**Controls:** click or space → next scene · ←/→ · 1 2 3 to jump.

**Embedding:** `?embed` hides the dials and hint, turns off saved settings, and pauses while off-screen. Add `&dials` to show the dials anyway.

```html
<iframe src="https://<deploy-url>/?embed" style="border:0;width:100%;aspect-ratio:16/9"></iframe>
```

**Shape scene:** set *source → image* to fill any SVG or PNG with particles.
