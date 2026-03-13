export interface MockResponse {
  trigger: RegExp;
  chunks: string[];
  generatesArtifact?: {
    id: string;
    name: string;
    type: "wireframe" | "deck" | "map" | "notes" | "app" | "diagram";
    status: "ready" | "generating";
    path: string;
    createdAt: string;
  };
}

export const mockResponses: MockResponse[] = [
  {
    trigger: /mind map|map/i,
    chunks: [
      "I'll create a mind map of everything we've discussed.",
      " Let me pull the key topics from our conversation...",
      "\n\nGenerating your mind map now.",
    ],
    generatesArtifact: {
      id: "gen-" + Date.now() + "-map",
      name: "Discussion Mind Map",
      type: "map",
      status: "ready",
      path: "/demo/map.html",
      createdAt: new Date().toISOString(),
    },
  },
  {
    trigger: /todo|task|tracker/i,
    chunks: [
      "I'll build a simple task tracker for you.",
      " Setting up the app with your project context...",
      "\n\nYour task app is ready on the desktop.",
    ],
    generatesArtifact: {
      id: "gen-" + Date.now() + "-app",
      name: "KPS Task Tracker",
      type: "app",
      status: "ready",
      path: "/demo/app.html",
      createdAt: new Date().toISOString(),
    },
  },
  {
    trigger: /present|deck|slide/i,
    chunks: [
      "I'll put together a presentation for you.",
      " Pulling in the key points and structuring the narrative...",
      "\n\nYour deck is ready on the desktop.",
    ],
    generatesArtifact: {
      id: "gen-" + Date.now() + "-deck",
      name: "Project Overview Deck",
      type: "deck",
      status: "ready",
      path: "/demo/deck.html",
      createdAt: new Date().toISOString(),
    },
  },
  {
    trigger: /diagram|flow|architecture/i,
    chunks: [
      "I'll create a diagram showing the architecture.",
      " Mapping the components and their relationships...",
      "\n\nYour diagram is on the desktop.",
    ],
    generatesArtifact: {
      id: "gen-" + Date.now() + "-diagram",
      name: "Architecture Diagram",
      type: "diagram",
      status: "ready",
      path: "/demo/wireframe.html",
      createdAt: new Date().toISOString(),
    },
  },
];

export const defaultChunks = [
  "I've noted that. ",
  "Let me structure this into your knowledge graph.",
  "\n\nDone — I've added the relevant nodes and relationships.",
];
