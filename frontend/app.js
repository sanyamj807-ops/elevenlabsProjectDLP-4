// ─────────────────────────────────────────────────────────────
//  ElevenLabs Narrator — Frontend Logic
//
//  What this file does, in order:
//    1. Defines sample texts for the "Random sample" button
//    2. Grabs references to every DOM element we need
//    3. Loads models + voices from the backend on page load
//    4. Wires up the character counter, sample button, and Play button
//    5. On Play: validates input → calls /api/narrate → plays audio blob
// ─────────────────────────────────────────────────────────────

// ── Sample paragraphs ─────────────────────────────────────────
// Each click of "Random sample" picks a different one at random.
// They vary in rhythm, vocabulary and length to showcase TTS quality.
const SAMPLES = [
  "The aurora borealis dances across the Arctic sky like ribbons of liquid light — greens, violets and blues that shift and breathe as though the atmosphere itself were alive. For those lucky enough to witness it, no photograph ever quite captures the feeling of standing in -30 °C silence while the heavens perform.",

  "Artificial intelligence is no longer the exclusive domain of science fiction. Within a single decade, language models have gone from struggling to write a grammatical sentence to drafting contracts, composing symphonies and tutoring students in real time. The question society now wrestles with is not whether AI is capable, but whether we are ready for it.",

  "In 44 BC, on the steps of the Roman Senate, Julius Caesar was struck twenty-three times. Historians still debate which blow was fatal. What they agree on is this: the conspirators who called themselves Liberators had saved the Republic in name only. Within eighteen months, Rome would be plunged into another civil war, and the Republic would never return.",

  "Forty-seven years have passed since Voyager 1 crossed into interstellar space — the first human-made object to do so. It is now more than 24 billion kilometres from Earth. A radio signal travelling at the speed of light takes over twenty-two hours to reach it. And yet, against all odds, it still calls home.",

  "The Mariana Trench plunges nearly eleven kilometres beneath the Pacific surface, deeper than Mount Everest is tall. Down there, in total darkness and under pressure that would crush an unprotected human instantly, life still finds a way — transparent shrimp, ghostly snailfish and microbes that feast on chemicals seeping from the seafloor.",

  "Socrates never wrote a single word. Everything we know about him comes through Plato, who may have put many of his own ideas into the old philosopher's mouth. And yet the Socratic method — asking relentless questions until a contradiction surfaces — remains the foundation of critical thinking, law school pedagogy and modern scientific debate.",

  "Kyoto exists in two time zones simultaneously. Walk one street and you pass a konbini glowing with fluorescent light, a teenager filming a TikTok; turn the corner and a maiko in full regalia glides silently past a five-hundred-year-old temple gate. Nowhere else on Earth holds the ancient and the contemporary in such effortless, unironic balance.",

  "On the night of 28 August 1963, Mahalia Jackson leaned toward the podium and called out to Martin Luther King: 'Tell them about the dream, Martin.' King set aside his prepared text and spoke from memory. In the eight minutes that followed, he delivered one of the most consequential speeches in American history — entirely improvised.",
];

// ── DOM references ────────────────────────────────────────────
// We grab every element once and reuse the references below.
const textInput   = document.getElementById("text-input");
const charCount   = document.getElementById("char-count");
const charRow     = document.getElementById("char-row");
const sampleBtn   = document.getElementById("sample-btn");
const modelSelect = document.getElementById("model-select");
const voiceSelect = document.getElementById("voice-select");
const playBtn     = document.getElementById("play-btn");
const errorMsg    = document.getElementById("error-msg");
const errorText   = document.getElementById("error-text");
const audioPlayer = document.getElementById("audio-player");

// Keeps track of the last audio Blob URL so we can release memory
// by calling URL.revokeObjectURL() before creating a new one.
let currentBlobUrl = null;

// ═════════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════════

/**
 * Changes which inner content the Play button shows.
 * @param {"idle"|"loading"|"playing"} state
 */
function setButtonState(state) {
  playBtn.dataset.state = state;

  // Keep screen readers in sync — only the active child is "visible"
  playBtn.querySelectorAll(".btn-state").forEach((el) => {
    el.setAttribute("aria-hidden", "true");
  });
  playBtn.querySelector(`.state-${state}`)?.setAttribute("aria-hidden", "false");

  // Disable the button while loading so it can't be double-clicked
  playBtn.disabled = (state === "loading");
}

/**
 * Shows a red error banner below the Play button.
 * @param {string} message
 */
function showError(message) {
  errorText.textContent = message;
  errorMsg.classList.add("visible");
}

/** Hides the error banner. */
function clearError() {
  errorMsg.classList.remove("visible");
  errorText.textContent = "";
}

/**
 * Updates the character counter and changes its colour
 * when the user is approaching or at the limit.
 */
function updateCharCount() {
  const len = textInput.value.length;
  charCount.textContent = len.toLocaleString();

  // Colour shifts: green → amber at 80 %, red at 95 %
  charRow.classList.toggle("warn",   len >= 4000 && len < 4750);
  charRow.classList.toggle("danger", len >= 4750);
}

// ═════════════════════════════════════════════════════════════
//  LOAD MODELS + VOICES
//  Called once on page load.  Both requests run in parallel
//  with Promise.all so we don't wait for one to finish before
//  starting the other.
// ═════════════════════════════════════════════════════════════
async function loadDropdowns() {
  try {
    // Fire both requests at the same time
    const [modelsRes, voicesRes] = await Promise.all([
      fetch("/api/models"),
      fetch("/api/voices"),
    ]);

    // Parse JSON from both responses
    const modelsData = await modelsRes.json();
    const voicesData = await voicesRes.json();

    // ── Populate model dropdown ───────────────────────────
    if (modelsData.error) throw new Error(modelsData.error);

    modelSelect.innerHTML = ""; // clear "Loading…" placeholder
    modelsData.models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value       = m.id;
      opt.textContent = m.name;
      modelSelect.appendChild(opt);
    });
    modelSelect.disabled = false;

    // ── Populate voice dropdown ───────────────────────────
    if (voicesData.error) throw new Error(voicesData.error);

    voiceSelect.innerHTML = "";
    voicesData.voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value       = v.id;
      opt.textContent = v.name;
      voiceSelect.appendChild(opt);
    });
    voiceSelect.disabled = false;

    // Enable Play only after both dropdowns are populated
    setButtonState("idle");
    playBtn.disabled = false;

  } catch (err) {
    // If the server is down or returns an error, tell the user clearly
    showError("Could not load models/voices — is the server running? " + err.message);
  }
}

// ═════════════════════════════════════════════════════════════
//  PLAY BUTTON
//  Validates input, calls POST /api/narrate, plays the MP3.
// ═════════════════════════════════════════════════════════════
playBtn.addEventListener("click", async () => {
  clearError();

  const text    = textInput.value.trim();
  const modelId = modelSelect.value;
  const voiceId = voiceSelect.value;

  // ── Client-side validation (mirrors server-side rules) ───
  if (!text) {
    showError("Please enter some text before clicking Play.");
    textInput.focus();
    return;
  }
  if (text.length > 5000) {
    showError("Text must be 5,000 characters or fewer.");
    return;
  }

  // ── Show loading state ───────────────────────────────────
  setButtonState("loading");

  try {
    // POST to our own backend — it calls ElevenLabs and streams audio back
    const res = await fetch("/api/speak", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text, modelId, voiceId }),
    });

    // The backend returns audio/mpeg on success, application/json on error
    const contentType = res.headers.get("Content-Type") || "";

    if (!res.ok || contentType.includes("application/json")) {
      // Parse the server's error message and show it to the user
      const data = await res.json();
      throw new Error(data.error || "An unexpected error occurred.");
    }

    // ── Convert the audio stream to a playable Blob URL ───
    const blob = await res.blob();

    // Free the memory used by the previous audio before creating a new URL
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
    }
    currentBlobUrl = URL.createObjectURL(blob);

    audioPlayer.src = currentBlobUrl;
    audioPlayer.play();

    setButtonState("playing");

  } catch (err) {
    // Show the safe error message from the server (never contains the API key)
    showError(err.message);
    setButtonState("idle");
  }
});

// ── When audio finishes, reset button to idle ─────────────────
audioPlayer.addEventListener("ended", () => {
  setButtonState("idle");
});

// ── If audio fails to play (e.g. bad blob) ───────────────────
audioPlayer.addEventListener("error", () => {
  showError("Could not play audio. Please try again.");
  setButtonState("idle");
});

// ═════════════════════════════════════════════════════════════
//  RANDOM SAMPLE BUTTON
//  Picks a paragraph that is different from the current one.
// ═════════════════════════════════════════════════════════════
sampleBtn.addEventListener("click", () => {
  const current = textInput.value.trim();

  // Filter out the paragraph already in the box so we always get something new
  const others = SAMPLES.filter((s) => s !== current);
  const pool   = others.length > 0 ? others : SAMPLES; // fallback if only 1 sample
  const picked = pool[Math.floor(Math.random() * pool.length)];

  textInput.value = picked;
  updateCharCount();
  clearError();

  // Move keyboard focus into the textarea so the user can edit immediately
  textInput.focus();
});

// ═════════════════════════════════════════════════════════════
//  CHARACTER COUNTER — updates on every keystroke
// ═════════════════════════════════════════════════════════════
textInput.addEventListener("input", updateCharCount);

// ═════════════════════════════════════════════════════════════
//  INITIALISE
//  Load dropdowns as soon as the page is ready.
// ═════════════════════════════════════════════════════════════
loadDropdowns();
