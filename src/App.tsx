import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import { Routes, Route, NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  House,
  Library,
  ChartNoAxesCombined,
  MessageCircle,
  Plus,
  Search,
  Settings,
  BookOpen,
  Menu,
  X,
  ChevronRight,
  ArrowUpRight,
  Flame,
  Layers,
  ArrowRight,
  Sparkles,
  Clock3,
} from 'lucide-react';
import { api } from './api';
import { Brand, CourseModal, Loading, CourseTile, SetTile, Empty, JobList } from './ui';
import type { AppData } from './types';
import {
  CoursePage,
  SetPage,
  CreateSet,
  EditSet,
  ProgressPage,
  ChatPage,
  SettingsPage,
} from './pages';
import Study from './Study';
import UpdateNotice from './components/UpdateNotice';
type Context = { data: AppData; refresh: () => Promise<void>; newCourse: () => void };
const Ctx = createContext<Context>(null!);
export const useApp = () => useContext(Ctx);
export default function App() {
  const [data, setData] = useState<AppData | null>(null),
    [error, setError] = useState(''),
    [courseModal, setCourseModal] = useState(false),
    [nav, setNav] = useState(false),
    [query, setQuery] = useState('');
  const location = useLocation(),
    navigate = useNavigate();
  const refresh = useCallback(async () => {
    try {
      setData(await api('/bootstrap'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);
  useEffect(() => {
    setNav(false);
    setQuery('');
    window.scrollTo(0, 0);
  }, [location.pathname]);
  if (!data)
    return error ? (
      <div className="empty">
        <h1>Studyroom couldn't connect</h1>
        <p>{error}</p>
        <button className="button primary" onClick={refresh}>
          Try again
        </button>
      </div>
    ) : (
      <Loading />
    );
  const study = /\/sets\/[^/]+\/(flashcards|learn|match|test)$/.test(location.pathname);
  const searchResults = query.trim()
    ? data.sets
        .filter((s) => (s.title + ' ' + s.description).toLowerCase().includes(query.toLowerCase()))
        .slice(0, 5)
    : [];
  return (
    <Ctx.Provider value={{ data, refresh, newCourse: () => setCourseModal(true) }}>
      {!study && (
        <>
          <header className="topbar">
            <button
              className="icon-button mobile-menu"
              aria-label="Open menu"
              onClick={() => setNav(!nav)}
            >
              <Menu size={23} />
            </button>
            <Brand />
            <div className="global-search">
              <Search size={19} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search your study sets"
                aria-label="Search your study sets"
              />
              {query && (
                <div className="search-results">
                  {searchResults.length ? (
                    searchResults.map((s) => (
                      <Link key={s.id} to={`/sets/${s.id}`}>
                        <Layers size={17} />
                        {s.title}
                        <ChevronRight size={16} />
                      </Link>
                    ))
                  ) : (
                    <p>No matching sets</p>
                  )}
                </div>
              )}
            </div>
            <button
              className="button primary create-top"
              onClick={() => (data.courses.length ? navigate('/create') : setCourseModal(true))}
            >
              <Plus size={19} />
              Create
            </button>
            <UpdateNotice />
            <Link to="/settings" className="avatar" aria-label="Your settings">
              {(data.settings.name || 'A').slice(0, 1).toUpperCase()}
            </Link>
          </header>
          <aside className={`sidebar ${nav ? 'open' : ''}`}>
            <nav>
              <NavLink to="/" end>
                <House size={21} />
                Home
              </NavLink>
              <NavLink to="/library">
                <Library size={21} />
                Your library
              </NavLink>
              <NavLink to="/progress">
                <ChartNoAxesCombined size={21} />
                Progress
              </NavLink>
              <NavLink to="/insights">
                <MessageCircle size={21} />
                Study insights<span className="tiny-new">AI</span>
              </NavLink>
            </nav>
            <div className="sidebar-label">
              <span>YOUR COURSES</span>
              <button
                className="icon-button"
                aria-label="Create a course"
                onClick={() => setCourseModal(true)}
              >
                <Plus size={17} />
              </button>
            </div>
            <div className="course-nav">
              {data.courses.map((c) => (
                <NavLink key={c.id} to={`/courses/${c.id}`}>
                  <BookOpen size={18} className={`text-${c.color}`} />
                  <span>{c.code || c.name}</span>
                </NavLink>
              ))}
              {!data.courses.length && (
                <button className="add-course" onClick={() => setCourseModal(true)}>
                  <Plus size={17} />
                  Add your first course
                </button>
              )}
            </div>
            <div className="sidebar-bottom">
              <div className="local-badge">
                <span />
                Your personal study space<small>Saved on this device</small>
              </div>
              <NavLink to="/settings">
                <Settings size={19} />
                Settings & data
              </NavLink>
            </div>
          </aside>
          {nav && (
            <button className="nav-scrim" aria-label="Close menu" onClick={() => setNav(false)} />
          )}
        </>
      )}
      {error && (
        <div className="connection-error">
          Connection interrupted. Your saved work is safe. Reconnecting…
        </div>
      )}
      <main className={study ? 'study-shell' : 'main-shell'}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/courses/:courseId" element={<CoursePage />} />
          <Route path="/sets/:setId" element={<SetPage />} />
          <Route path="/sets/:setId/edit" element={<EditSet />} />
          <Route path="/sets/:setId/:mode" element={<Study />} />
          <Route path="/create" element={<CreateSet />} />
          <Route path="/courses/:courseId/create" element={<CreateSet />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/insights" element={<ChatPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route
            path="*"
            element={
              <Empty
                title="That page isn't here"
                description="Your courses and sets are in your library."
              >
                <Link className="button primary" to="/library">
                  Go to library
                </Link>
              </Empty>
            }
          />
        </Routes>
      </main>
      <CourseModal open={courseModal} onOpenChange={setCourseModal} refresh={refresh} />
    </Ctx.Provider>
  );
}
function Home() {
  const { data, newCourse } = useApp();
  const greeting =
    new Date().getHours() < 12
      ? 'Good morning'
      : new Date().getHours() < 18
        ? 'Good afternoon'
        : 'Good evening';
  return (
    <div className="page home-page">
      <div className="eyebrow">YOUR SPACE TO LEARN</div>
      <div className="page-title row between">
        <div>
          <h1>
            {greeting}
            {data.settings.name ? `, ${data.settings.name}` : ''}.
          </h1>
          <p>Big ideas. Small study sessions. Make it stick.</p>
        </div>
        <span className="streak-pill">
          <Flame size={19} />
          {data.stats.streak} day streak
        </span>
      </div>
      <section className="home-hero">
        <div className="hero-copy">
          <span className="pill light">A LITTLE TODAY. A LOT OVER TIME.</span>
          <h2>
            {data.courses.length
              ? 'Pick up where your curiosity left off.'
              : 'Your next chapter starts here.'}
          </h2>
          <p>
            {data.courses.length
              ? 'Turn your course materials into the things you know. Your courses and next study session are right here.'
              : 'One place for every course, every material, and every lightbulb moment. Let’s make room for what you’re learning.'}
          </p>
          {data.courses.length ? (
            <Link to="/library" className="button dark">
              Let's study
              <ArrowRight size={18} />
            </Link>
          ) : (
            <button className="button dark" onClick={newCourse}>
              Create your first course
              <Plus size={18} />
            </button>
          )}
        </div>
        <div className="hero-illustration" aria-hidden="true">
          <span className="orbit one" />
          <span className="orbit two" />
          <div className="paper-back" />
          <div className="paper-front">
            <span className="paper-label">A LITTLE PRACTICE</span>
            <div className="paper-spark">✧</div>
            <span className="paper-answer">
              A lasting
              <br />
              understanding.
            </span>
            <div className="paper-line" />
            <div className="paper-line short" />
          </div>
          <div className="floating-check">✓</div>
          <div className="floating-star">✦</div>
        </div>
      </section>
      <div className="stats-row">
        <div>
          <span className="stat-icon purple">
            <Layers size={21} />
          </span>
          <div>
            <strong>{data.sets.length}</strong>
            <span>Study sets</span>
          </div>
        </div>
        <div>
          <span className="stat-icon blue">
            <Clock3 size={21} />
          </span>
          <div>
            <strong>{data.stats.due}</strong>
            <span>Cards due for review</span>
          </div>
        </div>
        <div>
          <span className="stat-icon green">
            <ChartNoAxesCombined size={21} />
          </span>
          <div>
            <strong>{data.stats.accuracy === null ? '—' : `${data.stats.accuracy}%`}</strong>
            <span>Practice accuracy</span>
          </div>
        </div>
      </div>
      <section>
        <div className="section-title">
          <h2>Your courses</h2>
          <button className="text-button" onClick={newCourse}>
            <Plus size={17} />
            New course
          </button>
        </div>
        {data.courses.length ? (
          <div className="course-grid">
            {data.courses.slice(0, 6).map((c) => (
              <CourseTile
                key={c.id}
                course={c}
                count={data.sets.filter((s) => s.courseId === c.id).length}
              />
            ))}
          </div>
        ) : (
          <button className="course-placeholder" onClick={newCourse}>
            <span className="circle-plus">
              <Plus size={23} />
            </span>
            <div>
              <strong>A place for your first course</strong>
              <p>Add a class, then bring in your materials.</p>
            </div>
            <ArrowRight size={20} />
          </button>
        )}
      </section>
      {data.sets.length > 0 && (
        <section>
          <div className="section-title">
            <h2>Recently created</h2>
            <Link to="/library" className="text-button">
              View library
              <ArrowRight size={16} />
            </Link>
          </div>
          <div className="set-grid">
            {[...data.sets]
              .reverse()
              .slice(0, 3)
              .map((s) => (
                <SetTile
                  key={s.id}
                  set={s}
                  course={data.courses.find((c) => c.id === s.courseId)}
                />
              ))}
          </div>
        </section>
      )}
      <Link to="/insights" className="insight-banner">
        <div className="insight-spark">
          <Sparkles size={24} />
        </div>
        <div>
          <h3>A clearer picture of your progress.</h3>
          <p>Ask what to practice next. Get an answer grounded in your study history.</p>
        </div>
        <ArrowUpRight size={23} />
      </Link>
    </div>
  );
}
function LibraryPage() {
  const { data, newCourse, refresh } = useApp();
  const [tab, setTab] = useState('sets'),
    [filter, setFilter] = useState('');
  return (
    <div className="page">
      <div className="page-title row between">
        <div>
          <h1>Your library</h1>
          <p>Everything you're learning, in one place.</p>
        </div>
        <Link to="/create" className="button primary">
          <Plus size={18} />
          Create new set
        </Link>
      </div>
      <div className="tabs">
        <button className={tab === 'sets' ? 'active' : ''} onClick={() => setTab('sets')}>
          Study sets <span>{data.sets.length}</span>
        </button>
        <button className={tab === 'courses' ? 'active' : ''} onClick={() => setTab('courses')}>
          Courses <span>{data.courses.length}</span>
        </button>
        <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>
          Activity
        </button>
      </div>
      {tab === 'jobs' ? (
        <JobList jobs={data.jobs} refresh={refresh} />
      ) : (
        <>
          <div className="filter-search">
            <Search size={18} />
            <input
              placeholder={`Find a ${tab === 'sets' ? 'study set' : 'course'}`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {tab === 'sets' ? (
            data.sets.length ? (
              <div className="set-grid">
                {data.sets
                  .filter((s) => s.title.toLowerCase().includes(filter.toLowerCase()))
                  .reverse()
                  .map((s) => (
                    <SetTile
                      key={s.id}
                      set={s}
                      course={data.courses.find((c) => c.id === s.courseId)}
                    />
                  ))}
              </div>
            ) : (
              <Empty
                title="Build your first study set"
                description="Upload materials or write your own cards. Every set works with all four study modes."
              >
                <Link to="/create" className="button primary">
                  <Plus size={18} />
                  Create a set
                </Link>
              </Empty>
            )
          ) : (
            <div className="course-grid">
              {data.courses
                .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
                .map((c) => (
                  <CourseTile
                    key={c.id}
                    course={c}
                    count={data.sets.filter((s) => s.courseId === c.id).length}
                  />
                ))}
              <button className="new-course-tile" onClick={newCourse}>
                <Plus size={26} />
                Create a course
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
