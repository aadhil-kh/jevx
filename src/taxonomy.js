/**
 * jevx: the conversation taxonomy (category → subcategory → reply-state
 * matrix), shared by the service worker (importScripts) and the content
 * script (listed before content.js in the manifest).
 *
 * The application owns this taxonomy; Jev only judges within it. The original
 * post is classified once into a subcategory, and that subcategory's reply
 * states are the options every reply in the thread is classified against.
 * Ids are derived from names, so renaming a state or a subcategory changes
 * the request and needs a CLASSIFIER_SCHEMA_VERSION bump in both scripts.
 */

(function (root) {
  "use strict";

  const slug = (name) =>
    name
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  const CATEGORIES = [
    ["Opinion & Debate", "States a view, take, prediction or comparison meant to be agreed or argued with."],
    ["Questions & Advice", "Asks for an answer, a solution, advice or a recommendation."],
    ["Product & Startup", "Launches, updates, prices or builds a product or company in public."],
    ["Developer & Engineering", "Code, bugs, tutorials, technical explanations, or releases of developer tools, libraries or APIs."],
    ["AI & Research", "AI models and products, benchmarks, research papers, or data and statistics claims."],
    ["News & Information", "Breaking news, rumors, corrections, security alerts or service outages."],
    ["Career & Business", "Hiring, career advice, business milestones, funding or strategy."],
    ["Personal & Social", "The author's life, achievements, stories, rants or appreciation of someone."],
    ["Entertainment & Culture", "Memes, movies and TV, gaming, sports, or consumer gadgets."],
    ["Society & Public Discussion", "Policy, politics, social issues, culture or ethics."],
    ["Other", "None of the above fits."],
  ];

  // [name, category, what the original post is, reply states]. Every matrix
  // ends with Other so Jev always has a "none of these" option.
  const SUBCATEGORIES = [
    ["General Opinion", "Opinion & Debate", "A general opinion or claim about any topic.",
      ["Agree", "Disagree", "Mixed", "Counterargument", "Question", "Joke", "Other"]],
    ["Hot Take", "Opinion & Debate", "A deliberately provocative or contrarian opinion.",
      ["Strong Agreement", "Agreement", "Pushback", "Rebuttal", "Mockery", "Clarification", "Other"]],
    ["Technical Opinion", "Opinion & Debate", "An opinion about technology, tools, languages or engineering practice.",
      ["Agree", "Disagree", "Counterexample", "Alternative", "Evidence", "Question", "Other"]],
    ["Prediction", "Opinion & Debate", "A forecast about what will happen.",
      ["Agree", "Disagree", "Alternative Prediction", "Conditional", "Supporting Evidence", "Opposing Evidence", "Joke", "Other"]],
    ["Comparison", "Opinion & Debate", "Compares two options (A vs B) and takes or invites a side.",
      ["Prefers A", "Prefers B", "Depends", "Neither", "Alternative", "Challenges Comparison", "Other"]],

    ["Factual Question", "Questions & Advice", "Asks for a fact or piece of information.",
      ["Direct Answer", "Partial Answer", "Correction", "Clarifying Question", "Source / Reference", "Uncertain", "Other"]],
    ["Technical Question", "Questions & Advice", "Asks how to solve a technical problem or why something breaks.",
      ["Solution", "Partial Solution", "Alternative Solution", "Correction", "Clarification Request", "Documentation / Reference", "Other"]],
    ["Advice Request", "Questions & Advice", "Asks what to do in a personal or professional situation.",
      ["Recommendation", "Personal Experience", "Warning", "Alternative", "Follow-up Question", "Caveat", "Other"]],
    ["Recommendation Request", "Questions & Advice", "Asks which product, tool, book or service to use.",
      ["Recommends Option", "Avoids Option", "Comparison", "Personal Experience", "Alternative", "Clarification", "Other"]],
    ["Which Is Better?", "Questions & Advice", "Asks which of two or more options is better.",
      ["Prefers A", "Prefers B", "Depends", "Neither", "Alternative", "Criteria Question", "Other"]],

    ["Product Launch", "Product & Startup", "Announces a new product.",
      ["Interested", "Praise", "Question", "Feature Request", "Pricing Concern", "Criticism", "Competitor Comparison", "Other"]],
    ["Feature Launch", "Product & Startup", "Announces a new feature in an existing product.",
      ["Praise", "Feature Request", "Bug Report", "Question", "Criticism", "Use Case", "Other"]],
    ["Product Update", "Product & Startup", "Announces an update, redesign or change to a product.",
      ["Positive Reaction", "Bug Report", "Regression", "Feature Request", "Migration Concern", "Question", "Other"]],
    ["Pricing Announcement", "Product & Startup", "Announces or changes a price or plan.",
      ["Accepts Pricing", "Too Expensive", "Good Value", "Pricing Question", "Alternative Pricing Suggestion", "Competitor Comparison", "Other"]],
    ["Startup Launch", "Product & Startup", "Announces a new company or startup.",
      ["Congratulations", "Customer Interest", "Product Feedback", "Founder Question", "Skepticism", "Competitor Mention", "Other"]],
    ["Build in Public", "Product & Startup", "Shares progress, numbers or lessons while building a product.",
      ["Encouragement", "Advice", "Question", "Criticism", "Similar Experience", "Business Suggestion", "Other"]],
    ["Feature Request", "Product & Startup", "Asks a product or company to add or change a feature.",
      ["Wants It", "Doesn't Want It", "Modification Suggestion", "Existing Solution", "Feasibility Concern", "Alternative Solution", "Other"]],

    ["Bug Report", "Developer & Engineering", "Reports a bug or broken behavior in software.",
      ["Confirms Bug", "Cannot Reproduce", "Workaround", "Fix Suggestion", "Needs More Details", "Related Bug", "Other"]],
    ["Code Snippet", "Developer & Engineering", "Shares a piece of code.",
      ["Improvement", "Bug / Problem", "Alternative Implementation", "Praise", "Question", "Performance Concern", "Other"]],
    ["Tutorial / How-To", "Developer & Engineering", "Teaches how to do something step by step.",
      ["Helpful", "Question", "Correction", "Alternative Method", "Missing Step", "Problem Encountered", "Other"]],
    ["Technical Explanation", "Developer & Engineering", "Explains how a technology or concept works.",
      ["Agreement", "Correction", "Additional Detail", "Counterexample", "Question", "Simplification", "Other"]],
    ["Developer Tool Release", "Developer & Engineering", "Releases a tool or app for developers.",
      ["Wants to Try", "Praise", "Feature Request", "Platform Request", "Bug Concern", "Comparison", "Question", "Other"]],
    ["Open-Source Release", "Developer & Engineering", "Releases an open-source project.",
      ["Praise", "Contribution Interest", "Feature Request", "Issue / Bug", "License Question", "Installation Question", "Alternative Project", "Other"]],
    ["Framework / Library Release", "Developer & Engineering", "Releases a new version of a framework or library.",
      ["Upgrade Interest", "Compatibility Concern", "Breaking Change Concern", "Performance Question", "Bug Report", "Comparison", "Other"]],
    ["API / SDK Release", "Developer & Engineering", "Releases an API, SDK or developer platform.",
      ["Integration Interest", "Documentation Question", "Missing Feature", "Compatibility Concern", "Pricing Concern", "Bug Report", "Other"]],

    ["AI Model Release", "AI & Research", "Releases or announces an AI model.",
      ["Impressed", "Benchmark Question", "Use-Case Idea", "Skepticism", "Pricing Question", "Comparison", "Limitation Concern", "Other"]],
    ["AI Product Release", "AI & Research", "Releases a product built on AI.",
      ["Interested", "Praise", "Use-Case Idea", "Feature Request", "Pricing Concern", "Comparison", "Skepticism", "Other"]],
    ["Benchmark Result", "AI & Research", "Shares benchmark or evaluation results.",
      ["Accepts Result", "Methodology Challenge", "Reproduction Request", "Alternative Benchmark", "Context Question", "Comparison", "Other"]],
    ["Research Paper", "AI & Research", "Shares or summarizes a research paper or finding.",
      ["Supports Finding", "Challenges Finding", "Methodology Question", "Interpretation", "Related Research", "Practical Implication", "Other"]],
    ["Data / Statistics Claim", "AI & Research", "Makes a claim backed by data or statistics.",
      ["Accepts Claim", "Source Request", "Methodology Challenge", "Context / Caveat", "Counter-Data", "Interpretation", "Other"]],

    ["Breaking News", "News & Information", "Reports a news event as it happens.",
      ["Reaction", "Additional Context", "Source Question", "Correction", "Analysis", "Skepticism", "Other"]],
    ["Rumor / Leak", "News & Information", "Shares an unconfirmed rumor or leak.",
      ["Believes Likely", "Skeptical", "Supporting Evidence", "Contradicting Evidence", "Source Request", "Speculation", "Other"]],
    ["Fact Check / Correction", "News & Information", "Corrects or fact-checks a claim.",
      ["Accepts Correction", "Disputes Correction", "Additional Evidence", "Source Challenge", "Clarification", "Meta Discussion", "Other"]],
    ["Security Alert", "News & Information", "Warns about a vulnerability, breach or scam.",
      ["Affected", "Not Affected", "Mitigation", "Technical Clarification", "Severity Discussion", "Patch Information", "Other"]],
    ["Outage / Service Status", "News & Information", "Reports that a service is down or degraded.",
      ["Also Affected", "Not Affected", "Region Specific", "Workaround", "Recovery Confirmed", "Complaint", "Question", "Other"]],

    ["Hiring Post", "Career & Business", "Advertises a job opening.",
      ["Interested Applicant", "Referral", "Qualification Question", "Compensation Question", "Remote / Location Question", "Criticism", "Other"]],
    ["Career Advice", "Career & Business", "Gives advice about careers or work.",
      ["Agreement", "Disagreement", "Personal Experience", "Additional Advice", "Exception", "Question", "Other"]],
    ["Revenue / Growth Milestone", "Career & Business", "Shares revenue, users or growth numbers.",
      ["Congratulations", "Business Question", "Skepticism", "Strategy Question", "Comparison", "Advice", "Other"]],
    ["Funding Announcement", "Career & Business", "Announces an investment or funding round.",
      ["Congratulations", "Investor Question", "Product Question", "Skepticism", "Market Discussion", "Hiring Interest", "Other"]],
    ["Business Strategy", "Career & Business", "Argues for a business strategy or practice.",
      ["Agree", "Disagree", "Alternative Strategy", "Personal Experience", "Caveat", "Question", "Other"]],

    ["Personal Update", "Personal & Social", "Shares news from the author's life.",
      ["Supportive", "Congratulations", "Empathy", "Advice", "Question", "Joke", "Other"]],
    ["Achievement / Milestone", "Personal & Social", "Celebrates a personal achievement.",
      ["Congratulations", "Praise", "Question", "Inspiration", "Skepticism", "Comparison", "Other"]],
    ["Personal Story", "Personal & Social", "Tells a story or experience from the author's life.",
      ["Relates", "Support", "Disagreement", "Advice", "Question", "Humor", "Other"]],
    ["Complaint / Rant", "Personal & Social", "Complains or vents about something.",
      ["Shared Frustration", "Disagrees", "Solution", "Explanation", "Similar Experience", "Joke", "Other"]],
    ["Appreciation / Praise", "Personal & Social", "Praises or thanks a person, product or thing.",
      ["Agrees", "Adds Praise", "Personal Experience", "Counterpoint", "Question", "Joke", "Other"]],

    ["Meme / Joke", "Entertainment & Culture", "A meme or joke.",
      ["Laughing / Positive", "Continues Joke", "Counter-Joke", "Didn't Understand", "Negative Reaction", "Explanation", "Other"]],
    ["Movie / TV Discussion", "Entertainment & Culture", "Discusses a movie, show or episode.",
      ["Positive", "Negative", "Character / Story Discussion", "Comparison", "Recommendation", "Question", "Joke", "Other"]],
    ["Gaming", "Entertainment & Culture", "Discusses a video game or gaming.",
      ["Positive", "Negative", "Gameplay Discussion", "Bug / Problem", "Comparison", "Recommendation", "Question", "Other"]],
    ["Sports Discussion", "Entertainment & Culture", "Discusses a sport, team, player or match.",
      ["Supports Take", "Opposes Take", "Player / Team Comparison", "Stats / Evidence", "Prediction", "Banter", "Other"]],
    ["Consumer Gadget", "Entertainment & Culture", "Discusses a phone, laptop or other consumer device.",
      ["Likes Product", "Dislikes Product", "Purchase Intent", "Feature Question", "Price Concern", "Alternative Product", "Personal Experience", "Other"]],

    ["Public Policy", "Society & Public Discussion", "Discusses a law, regulation or government policy.",
      ["Supports Position", "Opposes Position", "Mixed / Conditional", "Factual Challenge", "Policy Impact Discussion", "Question", "Other"]],
    ["Political Discussion", "Society & Public Discussion", "Makes a political claim or discusses politicians.",
      ["Supports Claim", "Opposes Claim", "Mixed", "Factual Challenge", "Evidence / Context", "Question", "Other"]],
    ["Social Issue", "Society & Public Discussion", "Discusses a social issue.",
      ["Agrees", "Disagrees", "Personal Experience", "Nuance", "Factual Challenge", "Question", "Other"]],
    ["Culture Discussion", "Society & Public Discussion", "Discusses culture, trends or norms.",
      ["Agrees", "Disagrees", "Personal Experience", "Context", "Counterexample", "Question", "Other"]],
    ["Ethical Debate", "Society & Public Discussion", "Argues a moral or ethical position.",
      ["Accepts Reasoning", "Rejects Reasoning", "Conditional", "Alternative Principle", "Counterexample", "Question", "Other"]],

    ["General Discussion", "Other", "Anything that fits none of the subcategories above.",
      ["Agreement", "Disagreement", "Question", "Information", "Suggestion", "Humor", "Other"]],
  ];

  // Descriptions for states whose name alone is ambiguous, keyed by state id.
  // Sent as the choice option's description; any other state is sent with
  // `null` (the name says enough).
  const STATE_HINTS = {
    other: "None of the other options describes the reply.",
    mixed: "Partly agrees and partly disagrees.",
    counterargument: "Gives a reason, evidence or argument against the post.",
    joke: "Mainly humor, a meme, wordplay or playful sarcasm.",
    humor: "Mainly humor, a meme, wordplay or playful sarcasm.",
    question: "Mainly asks a question, sincere or rhetorical.",
    prefers_a: "Prefers the first option the post compares.",
    prefers_b: "Prefers the second option the post compares.",
    depends: "Says the better option depends on the situation.",
    neither: "Rejects all the options compared.",
    alternative: "Proposes a different option than those in the post.",
    evidence: "Adds evidence, data or sources about the post's claim.",
    conditional: "Agrees only under certain conditions.",
    pushback: "Mild disagreement or doubt, without a full argument.",
    rebuttal: "A direct, argued refutation of the take.",
    mockery: "Ridicules the post or its author.",
    clarification: "Asks for or offers clarification of what the post means.",
    uncertain: "Tries to answer but says it is unsure.",
    interested: "Expresses interest in using or buying it.",
    criticism: "Criticizes it, beyond a specific bug or price concern.",
    competitor_comparison: "Compares it with a competing product.",
    use_case: "Describes a way the reply's author would use it.",
    regression: "Something that used to work is now broken.",
    information: "Adds facts, context or links.",
    suggestion: "Proposes an idea or improvement.",
    reaction: "An emotional reaction with no further content.",
    additional_context: "Adds background facts or context.",
    analysis: "Interprets the implications of the news.",
    skepticism: "Doubts the claim, numbers or quality.",
    skeptical: "Doubts the rumor is true.",
    speculation: "Guesses beyond the available facts.",
    meta_discussion: "Discusses fact-checking or the correction process itself.",
    positive_reaction: "Welcomes the change.",
    supportive: "Offers support or encouragement.",
    empathy: "Expresses sympathy or understanding.",
    relates: "Says the same thing happened to them.",
    inspiration: "Says the post inspires or motivates them.",
    nuance: "Adds nuance without clearly agreeing or disagreeing.",
    context: "Adds historical or cultural context.",
    banter: "Friendly teasing between fans.",
    laughing_positive: "Laughs at or enjoys the joke.",
    negative_reaction: "Dislikes or is offended by the joke.",
    explanation: "Explains the joke or the situation.",
    helpful: "Says the tutorial or answer helped.",
    exception: "Points out a case where the advice does not apply.",
    caveat: "Adds a limitation or warning to the point.",
    wants_it: "Supports the requested feature.",
    doesnt_want_it: "Opposes the requested feature.",
    existing_solution: "Points out the feature or a workaround already exists.",
    feasibility_concern: "Doubts the feature can or should be built.",
    also_affected: "Has the same problem.",
    not_affected: "Says it works fine for them.",
    affected: "Says they are affected.",
    complaint: "Complains about the outage or the company.",
  };

  const matrix = (names) => names.map((name) => ({ id: slug(name), name }));

  const categories = CATEGORIES.map(([name, description]) => ({ id: slug(name), name, description }));
  const subcategories = SUBCATEGORIES.map(([name, category, description, states]) => ({
    id: slug(name),
    name,
    category: slug(category),
    description,
    states: matrix(states),
  }));

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const subcategoryById = new Map(subcategories.map((s) => [s.id, s]));

  root.JEVX_TAXONOMY = Object.freeze({
    FALLBACK_SUBCATEGORY: "general_discussion",
    categories,
    subcategories,
    stateHint: (id) => (Object.prototype.hasOwnProperty.call(STATE_HINTS, id) ? STATE_HINTS[id] : null),
    category: (id) => categoryById.get(id) || null,
    subcategory: (id) => subcategoryById.get(id) || null,
  });
})(globalThis);
