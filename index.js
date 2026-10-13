const express = require("express");
const path = require("path");
const session = require("express-session");
const methodOverride = require("method-override");
const { Pool } = require("pg");

// Main Express app setup for the blog application.
const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL connection string. The app will try to connect to BlogDB and
// gracefully fall back to an in-memory store if the database is unavailable.
const connectionString =
  process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/BlogDB";

// Pool manages database connections for the app.
const pool = new Pool({
  connectionString,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Fallback storage used only if PostgreSQL is not running locally.
const fallbackUsers = [];
let fallbackNextUserId = 1;
const fallbackPosts = [];
let fallbackNextPostId = 1;
let dbReady = false;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: true }));
app.use(methodOverride("_method"));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mini-project-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 8 },
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Ensures the required database tables exist and preloads sample data.
async function tableSetup() {
  try {
    await pool.query("SELECT 1");
    dbReady = true;

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id VARCHAR(255) PRIMARY KEY,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS blogs (
        blog_id SERIAL PRIMARY KEY,
        creator_name VARCHAR(255) NOT NULL,
        creator_user_id VARCHAR(255) NOT NULL,
        title VARCHAR(255) NOT NULL,
        body TEXT NOT NULL,
        date_created TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (creator_user_id) REFERENCES users(user_id)
      );
    `);

    const userCount = await pool.query("SELECT COUNT(*)::int AS count FROM users");
    if (userCount.rows[0].count === 0) {
      await pool.query(
        `INSERT INTO users (user_id, password, name) VALUES
          ('alice', 'pass123', 'Alice Johnson'),
          ('bob', 'pass123', 'Bob Smith'),
          ('charlie', 'pass123', 'Charlie Brown');`
      );
    }

    const postCount = await pool.query("SELECT COUNT(*)::int AS count FROM blogs");
    if (postCount.rows[0].count === 0) {
      const initialPosts = [
        ["alice", "Alice Johnson", "Starting a New Chapter", "This is my first blog post. I am excited to begin this journaling journey and document my ideas, learning, and growth."],
        ["bob", "Bob Smith", "A Morning Walk and Fresh Ideas", "A simple walk in the morning can clear the mind and spark new ideas. The world feels calmer when you make space to think."],
        ["charlie", "Charlie Brown", "Why Small Habits Matter", "Consistency matters more than intensity. Small habits build momentum and create lasting change over time."],
        ["alice", "Alice Johnson", "Learning Through Practice", "Understanding a topic deeply takes repetition and curiosity. Rehearsing the fundamentals makes the bigger ideas easier to appreciate."],
        ["bob", "Bob Smith", "What I Want to Build Next", "The next project I want to build is one that is practical, useful, and meaningful for others. Good ideas become great when they solve real problems."],
      ];

      for (const [userId, name, title, body] of initialPosts) {
        await pool.query(
          `INSERT INTO blogs (creator_name, creator_user_id, title, body, date_created)
           VALUES ($1, $2, $3, $4, NOW())`,
          [name, userId, title, body]
        );
      }
    }

    console.log("Database connected and initialized.");
  } catch (error) {
    dbReady = false;
    console.warn("PostgreSQL unavailable. Using in-memory fallback store.");
    console.warn(error.message);
  }
}

// Creates a new user record and prevents duplicate user IDs.
async function createUserInStore(userId, password, name) {
  const cleanUserId = normalizeText(userId);
  const cleanPassword = normalizeText(password);
  const cleanName = normalizeText(name);

  if (!cleanUserId || !cleanPassword || !cleanName) {
    return null;
  }

  if (dbReady) {
    const result = await pool.query(
      `INSERT INTO users (user_id, password, name) VALUES ($1, $2, $3) RETURNING *`,
      [cleanUserId, cleanPassword, cleanName]
    );
    return result.rows[0];
  }

  const existing = fallbackUsers.find((user) => user.user_id === cleanUserId);
  if (existing) {
    return null;
  }

  const user = {
    user_id: cleanUserId,
    password: cleanPassword,
    name: cleanName,
  };
  fallbackUsers.push(user);
  return user;
}

// Looks up a user by ID so the sign-in route can validate credentials.
async function findUserById(userId) {
  const cleanUserId = normalizeText(userId);

  if (dbReady) {
    const result = await pool.query(
      `SELECT * FROM users WHERE user_id = $1`,
      [cleanUserId]
    );
    return result.rows[0] || null;
  }

  return fallbackUsers.find((user) => user.user_id === cleanUserId) || null;
}

// Fetches all blog posts from the database in newest-first order.
async function getPosts() {
  if (dbReady) {
    const result = await pool.query(
      `SELECT blog_id AS id, creator_name AS author, creator_user_id, title, body AS content, date_created AS createdAt
       FROM blogs
       ORDER BY date_created DESC`
    );
    return result.rows;
  }

  return [...fallbackPosts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function getPostById(postId) {
  const id = Number(postId);

  if (dbReady) {
    const result = await pool.query(
      `SELECT blog_id AS id, creator_name AS author, creator_user_id, title, body AS content, date_created AS createdAt
       FROM blogs WHERE blog_id = $1`,
      [id]
    );
    return result.rows[0] || null;
  }

  return fallbackPosts.find((post) => post.id === id) || null;
}

// Adds a new post to the blogs table and stores the current user as the creator.
async function insertPost({ title, body, creatorName, creatorUserId }) {
  const cleanTitle = normalizeText(title);
  const cleanBody = normalizeText(body);

  if (!cleanTitle || !cleanBody) {
    return null;
  }

  if (dbReady) {
    const result = await pool.query(
      `INSERT INTO blogs (creator_name, creator_user_id, title, body, date_created)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING blog_id AS id, creator_name AS author, creator_user_id, title, body AS content, date_created AS createdAt`,
      [creatorName, creatorUserId, cleanTitle, cleanBody]
    );
    return result.rows[0];
  }

  const post = {
    id: fallbackNextPostId++,
    author: creatorName,
    creator_user_id: creatorUserId,
    title: cleanTitle,
    content: cleanBody,
    createdAt: new Date().toISOString(),
  };
  fallbackPosts.unshift(post);
  return post;
}

// Updates an existing blog entry after verifying the user owns the post.
async function updatePostById(postId, title, body) {
  const id = Number(postId);
  const cleanTitle = normalizeText(title);
  const cleanBody = normalizeText(body);

  if (dbReady) {
    const result = await pool.query(
      `UPDATE blogs
       SET title = $1, body = $2
       WHERE blog_id = $3
       RETURNING blog_id AS id, creator_name AS author, creator_user_id, title, body AS content, date_created AS createdAt`,
      [cleanTitle, cleanBody, id]
    );
    return result.rows[0] || null;
  }

  const index = fallbackPosts.findIndex((post) => post.id === id);
  if (index === -1) {
    return null;
  }

  fallbackPosts[index] = {
    ...fallbackPosts[index],
    title: cleanTitle,
    content: cleanBody,
  };

  return fallbackPosts[index];
}

// Removes a blog post permanently from the database.
async function deletePostById(postId) {
  const id = Number(postId);

  if (dbReady) {
    const result = await pool.query(
      `DELETE FROM blogs WHERE blog_id = $1 RETURNING blog_id AS id`,
      [id]
    );
    return result.rowCount > 0;
  }

  const originalLength = fallbackPosts.length;
  const filtered = fallbackPosts.filter((post) => post.id !== id);
  fallbackPosts.length = 0;
  fallbackPosts.push(...filtered);
  return filtered.length !== originalLength;
}

app.get("/", async (req, res) => {
  const posts = await getPosts();
  res.render("index", {
    posts,
    user: req.session.user || null,
    error: req.query.error || "",
    success: req.query.success || "",
  });
});

app.get("/signup", (req, res) => {
  res.render("signup", {
    user: req.session.user || null,
    error: req.query.error || "",
  });
});

// Signup flow: verify the username is available, insert the new user, and
// redirect to the sign-in page.
app.post("/signup", async (req, res) => {
  const { user_id, password, name } = req.body;
  const cleanUserId = normalizeText(user_id);
  const cleanPassword = normalizeText(password);
  const cleanName = normalizeText(name);

  if (!cleanUserId || !cleanPassword || !cleanName) {
    return res.redirect("/signup?error=Please complete all signup fields.");
  }

  const existingUser = await findUserById(cleanUserId);
  if (existingUser) {
    return res.redirect("/signup?error=That user ID is already taken. Please choose another one.");
  }

  const user = await createUserInStore(cleanUserId, cleanPassword, cleanName);
  if (!user) {
    return res.redirect("/signup?error=Unable to create the user account.");
  }

  res.redirect("/signin?success=Your account was created. Please sign in.");
});

app.get("/signin", (req, res) => {
  res.render("signin", {
    user: req.session.user || null,
    error: req.query.error || "",
    success: req.query.success || "",
  });
});

// Sign-in flow: compare submitted credentials against the users table and store
// the active user in the session when they match.
app.post("/signin", async (req, res) => {
  const { user_id, password } = req.body;
  const cleanUserId = normalizeText(user_id);
  const cleanPassword = normalizeText(password);

  const user = await findUserById(cleanUserId);
  if (!user || user.password !== cleanPassword) {
    return res.redirect("/signin?error=Invalid user ID or password. Please try again.");
  }

  req.session.user = { user_id: user.user_id, name: user.name };
  res.redirect("/");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/signin?success=You have been logged out.");
  });
});

// New post creation route. The logged-in user’s ID and name are linked to the
// blog entry when it is inserted into the database.
app.post("/posts", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/signin?error=Please sign in before creating a post.");
  }

  const { title, body } = req.body;
  const cleanTitle = normalizeText(title);
  const cleanBody = normalizeText(body);

  if (!cleanTitle || !cleanBody) {
    return res.redirect("/?error=Title and content are both required.");
  }

  await insertPost({
    title: cleanTitle,
    body: cleanBody,
    creatorName: req.session.user.name,
    creatorUserId: req.session.user.user_id,
  });

  res.redirect("/");
});

// Edit route checks that the current user owns the blog before showing the form.
app.get("/posts/:id/edit", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/signin?error=Please sign in to edit a post.");
  }

  const post = await getPostById(req.params.id);
  if (!post) {
    return res.redirect("/?error=Post not found.");
  }

  if (post.creator_user_id !== req.session.user.user_id) {
    return res.redirect("/?error=You can only edit your own posts.");
  }

  res.render("edit", {
    post,
    user: req.session.user,
  });
});

// Update route writes changes to the post and only allows updates by the creator.
app.put("/posts/:id", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/signin?error=Please sign in to update a post.");
  }

  const post = await getPostById(req.params.id);
  if (!post) {
    return res.redirect("/?error=Post not found.");
  }

  if (post.creator_user_id !== req.session.user.user_id) {
    return res.redirect("/?error=You can only edit your own posts.");
  }

  const { title, content } = req.body;
  const cleanTitle = normalizeText(title);
  const cleanContent = normalizeText(content);

  if (!cleanTitle || !cleanContent) {
    return res.redirect(`/posts/${req.params.id}/edit`);
  }

  await updatePostById(req.params.id, cleanTitle, cleanContent);
  res.redirect("/");
});

// Delete route permanently removes the post and blocks access if the user is not
// the original author.
app.delete("/posts/:id", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/signin?error=Please sign in to delete a post.");
  }

  const post = await getPostById(req.params.id);
  if (!post) {
    return res.redirect("/?error=Post not found.");
  }

  if (post.creator_user_id !== req.session.user.user_id) {
    return res.redirect("/?error=You can only delete your own posts.");
  }

  await deletePostById(req.params.id);
  res.redirect("/");
});

async function startServer() {
  await tableSetup();
  app.listen(PORT, () => {
    console.log(`Blog app running at http://localhost:${PORT}`);
  });
}

startServer();
