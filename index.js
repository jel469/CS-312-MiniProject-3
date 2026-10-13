// Using Express, Ejs, and PostgreSQL for main functionalities
const express = require("express");
const path = require("path");
const session = require("express-session");
const methodOverride = require("method-override");
const { Pool } = require("pg");

// Starting the app
const app = express();
const port = process.env.PORT || 3000;
const dbUrl = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/BlogDB";

// Connecting to postgres for database
const pool = new Pool({
  connectionString: dbUrl,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

// Backup data setup just in case
const fallbackUsers = [];
const fallbackPosts = [];
let nextPostId = 1;
let dbReady = false;

// Setting up views and middleware
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

// Removing extra spaces from user input for cleaniness
function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

// make the database tables if they do not exist
async function setUpTables() {
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

    const userCheck = await pool.query("SELECT COUNT(*)::int AS count FROM users");
    if (userCheck.rows[0].count === 0) {
      await pool.query(`
        INSERT INTO users (user_id, password, name) VALUES
          ('alice', 'pass123', 'Alice Johnson'),
          ('bob', 'pass123', 'Bob Smith'),
          ('charlie', 'pass123', 'Charlie Brown');
      `);
    }

    const postCheck = await pool.query("SELECT COUNT(*)::int AS count FROM blogs");
    if (postCheck.rows[0].count === 0) {
      const stuff = [
        ["alice", "Alice Johnson", "Starting a New Chapter", "This is my first blog post. I am excited to begin this journaling journey and document my ideas, learning, and growth."],
        ["bob", "Bob Smith", "A Morning Walk and Fresh Ideas", "A simple walk in the morning can clear the mind and spark new ideas. The world feels calmer when you make space to think."],
        ["charlie", "Charlie Brown", "Why Small Habits Matter", "Consistency matters more than intensity. Small habits build momentum and create lasting change over time."],
        ["alice", "Alice Johnson", "Learning Through Practice", "Understanding a topic deeply takes repetition and curiosity. Rehearsing the fundamentals makes the bigger ideas easier to appreciate."],
        ["bob", "Bob Smith", "What I Want to Build Next", "The next project I want to build is one that is practical, useful, and meaningful for others. Good ideas become great when they solve real problems."],
      ];

      for (const [userId, name, title, body] of stuff) {
        await pool.query(
          `INSERT INTO blogs (creator_name, creator_user_id, title, body, date_created)
           VALUES ($1, $2, $3, $4, NOW())`,
          [name, userId, title, body]
        );
      }
    }

    console.log("DB working");
  } catch (err) {
    dbReady = false;
    console.log("DB not working, using local data instead");
  }
}

// create a new user functionality
async function createUser(userId, password, name) {
  const cleanUserId = cleanText(userId);
  const cleanPassword = cleanText(password);
  const cleanName = cleanText(name);

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

  const alreadyThere = fallbackUsers.find((user) => user.user_id === cleanUserId);
  if (alreadyThere) {
    return null;
  }

  const newUser = {
    user_id: cleanUserId,
    password: cleanPassword,
    name: cleanName,
  };

  fallbackUsers.push(newUser);
  return newUser;
}

// find a user using their username
async function findUser(userId) {
  const cleanUserId = cleanText(userId);

  if (dbReady) {
    const result = await pool.query(`SELECT * FROM users WHERE user_id = $1`, [cleanUserId]);
    return result.rows[0] || null;
  }
  return fallbackUsers.find((user) => user.user_id === cleanUserId) || null;
}

// Getting all blog posts from database
async function getPosts() {
  if (dbReady) {
    const result = await pool.query(`
      SELECT blog_id AS id, creator_name AS author, creator_user_id, title, body AS content, date_created AS createdAt
      FROM blogs
      ORDER BY date_created DESC
    `);
    return result.rows;
  }

  return [...fallbackPosts].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// get one post by its id from database
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

// Blog post adding functionality
async function addPost(postInfo) {
  const title = cleanText(postInfo.title);
  const body = cleanText(postInfo.body);

  if (!title || !body) {
    return null;
  }

  if (dbReady) {
    const result = await pool.query(
      `INSERT INTO blogs (creator_name, creator_user_id, title, body, date_created)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING blog_id AS id, creator_name AS author, creator_user_id, title, body AS content, date_created AS createdAt`,
      [postInfo.creatorName, postInfo.creatorUserId, title, body]
    );
    return result.rows[0];
  }

  const post = {
    id: nextPostId++,
    author: postInfo.creatorName,
    creator_user_id: postInfo.creatorUserId,
    title: title,
    content: body,
    createdAt: new Date().toISOString(),
  };

  fallbackPosts.unshift(post);
  return post;
}

// Updating post functionality
async function updatePost(postId, title, body) {
  const id = Number(postId);
  const cleanTitle = cleanText(title);
  const cleanBody = cleanText(body);

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

// Deleting post functionality
async function deletePost(postId) {
  const id = Number(postId);

  if (dbReady) {
    const result = await pool.query(`DELETE FROM blogs WHERE blog_id = $1 RETURNING blog_id AS id`, [id]);
    return result.rowCount > 0;
  }

  const oldLength = fallbackPosts.length;
  const filtered = fallbackPosts.filter((post) => post.id !== id);
  fallbackPosts.length = 0;
  fallbackPosts.push(...filtered);
  return filtered.length !== oldLength;
}

// home page shows all posts
app.get("/", async (req, res) => {
  const posts = await getPosts();
  res.render("index", {
    posts,
    user: req.session.user || null,
    error: req.query.error || "",
    success: req.query.success || "",
  });
});

// Sign up page
app.get("/signup", (req, res) => {
  res.render("signup", {
    user: req.session.user || null,
    error: req.query.error || "",
  });
});

// sign up page with new account
app.post("/signup", async (req, res) => {
  const { user_id, password, name } = req.body;
  const cleanUserId = cleanText(user_id);
  const cleanPassword = cleanText(password);
  const cleanName = cleanText(name);

  if (!cleanUserId || !cleanPassword || !cleanName) {
    return res.redirect("/signup?error=Please complete all signup fields.");
  }

  const existing = await findUser(cleanUserId);
  if (existing) {
    return res.redirect("/signup?error=That user ID is already taken. Please choose another one.");
  }

  const newUser = await createUser(cleanUserId, cleanPassword, cleanName);
  if (!newUser) {
    return res.redirect("/signup?error=Unable to create the user account.");
  }

  res.redirect("/signin?success=Your account was created. Please sign in.");
});

// Sign in page, app.get
app.get("/signin", (req, res) => {
  res.render("signin", {
    user: req.session.user || null,
    error: req.query.error || "",
    success: req.query.success || "",
  });
});

// Log in user w/ credentials
app.post("/signin", async (req, res) => {
  const { user_id, password } = req.body;
  const cleanUserId = cleanText(user_id);
  const cleanPassword = cleanText(password);

  const user = await findUser(cleanUserId);
  if (!user || user.password !== cleanPassword) {
    return res.redirect("/signin?error=Invalid user ID or password. Please try again.");
  }

  req.session.user = { user_id: user.user_id, name: user.name };
  res.redirect("/");
});

// Log out user
app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/signin?success=You have been logged out.");
  });
});

// Creating post functionality, using app.post
app.post("/posts", async (req, res) => {
  if (!req.session.user) {
    return res.redirect("/signin?error=Please sign in before creating a post.");
  }

  const { title, body } = req.body;
  const cleanTitle = cleanText(title);
  const cleanBody = cleanText(body);

  if (!cleanTitle || !cleanBody) {
    return res.redirect("/?error=Title and content are both required.");
  }

  await addPost({
    title: cleanTitle,
    body: cleanBody,
    creatorName: req.session.user.name,
    creatorUserId: req.session.user.user_id,
  });

  res.redirect("/");
});

// Show the edit page, app.get
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

// Updating a post w/ app.put
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
  const cleanTitle = cleanText(title);
  const cleanContent = cleanText(content);

  if (!cleanTitle || !cleanContent) {
    return res.redirect(`/posts/${req.params.id}/edit`);
  }

  await updatePost(req.params.id, cleanTitle, cleanContent);
  res.redirect("/");
});

// Delete post
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

  await deletePost(req.params.id);
  res.redirect("/");
});

// start server, app listen
async function startServer() {
  await setUpTables();
  app.listen(port, () => {
    console.log(`Blog app running at http://localhost:${port}`);
  });
}

startServer();
