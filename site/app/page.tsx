import { Fragment } from 'react';
import type { Metadata } from 'next';
import { docsIntro, landingCopy } from '../lib/readme.mjs';
import { BRANCH, REPO_URL } from '../lib/links.mjs';
import { pageMetadata } from '../lib/meta.mjs';
import { CopyButtons } from '../components/docs/CopyButtons';
import { Terminals } from '../components/landing/Terminals';
import { Vignette } from '../components/landing/Vignette';
import { Assemble } from '../components/site/Assemble';
import { BASE_PATH, SITE_URL, asset, href } from '../components/site/base';
import { FILM_PATH, HAS_DEMO, HAS_FILM, REPO_DIR, docsPageSet, howItWorksSvg } from '../components/site/build-info';
import { Footer } from '../components/site/Footer';
import { Header } from '../components/site/Header';
import { Room } from '../components/site/Room';
import { OfficeToy } from '../components/toy/OfficeToy';
import './landing.css';

const TITLE = 'Luady: a pixel-art office for your Claude Code sessions';
const DESCRIPTION = 'Luady is a self-hosted, open-source web app that shows your Claude Code sessions on all your servers as a pixel-art '
  + 'office, and lets you steer them from one browser tab.';

export const metadata: Metadata = pageMetadata({ siteUrl: SITE_URL === '' ? null : SITE_URL, path: '', title: TITLE, description: DESCRIPTION });

const LINE = 'A pixel-art office for your Claude Code sessions, on all your servers.';
const blob = (path: string) => `${REPO_URL}/blob/${BRANCH}/${path}`;

/** Text from README.md, rendered at build time (see lib/readme.mjs). */
function Html({ html, as: Tag = 'span', className }: { html: string; as?: 'span' | 'li' | 'p'; className?: string }) {
  return <Tag className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function Code({ lines }: { lines: string }) {
  return (
    <div className="codeblock codeblock--shell">
      <pre><code>{lines.split('\n').map((line, i) => <span className="ln" key={i}>{line}{'\n'}</span>)}</code></pre>
      <button type="button" className="codeblock__copy" hidden>Copy</button>
    </div>
  );
}

export default function LandingPage() {
  const pages = docsPageSet();
  const copy = landingCopy(REPO_DIR, pages, BASE_PATH);
  const demo = HAS_DEMO ? href('demo/') : null;
  return (
    <>
      <a className="skip" href="#main">Skip to the content</a>
      <Header demo={HAS_DEMO} />
      <main id="main" tabIndex={-1}>
        <div className="sky">
          <section className="hero wrap" aria-labelledby="hero-title">
            <div className="hero__text">
              <h1 className="hero__title" id="hero-title">
                <span className="hero__mark">
                  <img className="hero__logo" src={asset('brand/logo.svg')} width={96} height={96} alt="" />
                  <span className="wordmark">Luady</span>
                </span>
                <span className="sr-only">: </span>
                <span className="hero__line">
                  {LINE.split(' ').map((word, i) => (
                    <Fragment key={i}>{i > 0 ? ' ' : null}<span className="word">{word}</span></Fragment>
                  ))}
                </span>
              </h1>
              <div className="hero__side">
                <p className="hero__sub">
                  Self-hosted and open source. For developers who run Claude Code on more than one machine and want to see
                  and steer it all from one browser tab.
                </p>
                <div className="hero__actions">
                  {demo === null ? null : <a className="btn btn--primary" href={demo}>Try the live demo</a>}
                  <a className={demo === null ? 'btn btn--primary' : 'btn'} href={href('docs/getting-started/')}>Get started</a>
                  <a className="btn" href={REPO_URL}>GitHub</a>
                </div>
                {demo === null ? null : (
                  <p className="hero__quiet">The live demo is the office page with a pretend hub inside your browser: nothing to install.</p>
                )}
                {HAS_FILM ? (
                  <details className="film">
                    <summary className="btn btn--small">Watch the film</summary>
                    <video className="film__video" controls preload="none" playsInline src={asset(FILM_PATH)}>
                      <a href={asset(FILM_PATH)}>Download the film</a>
                    </video>
                  </details>
                ) : null}
              </div>
            </div>
          </section>
          <div className="wrap hero__toy">
            <OfficeToy demoHref={demo} />
          </div>
        </div>

        <Terminals intro={docsIntro(REPO_DIR, pages, BASE_PATH)} />

        <Room id="what-you-see" colour="rose" title="What you see" lead={<span dangerouslySetInnerHTML={{ __html: copy.lead }} />}>
          <div className="cards">
            <article className="card">
              <Vignette kind="servers" />
              <div className="card__body">
                <h3>{copy.servers.title}</h3>
                <Html as="p" html={copy.servers.html} />
                <details className="card__shot">
                  <summary>See it in the real office</summary>
                  <img src={asset('assets/feature-servers.png')} width={800} height={500} loading="lazy" decoding="async"
                    alt="The whole office: rooms for three servers around the manager's headquarters, one spot still free." />
                </details>
              </div>
            </article>
            <article className="card">
              <Vignette kind="rooms" />
              <div className="card__body">
                <h3>{copy.rooms.title}</h3>
                <Html as="p" html={copy.rooms.html} />
                <details className="card__shot">
                  <summary>See it in the real office</summary>
                  <img src={asset('assets/feature-rooms.png')} width={800} height={500} loading="lazy" decoding="async"
                    alt="The room editor: what the room is for, the server, the name, twelve colours and five creatures." />
                </details>
              </div>
            </article>
            <article className="card">
              <Vignette kind="ask" />
              <div className="card__body">
                <h3>Talk to your sessions</h3>
                <Html as="p" html={copy.talk} />
                <details className="card__shot">
                  <summary>See it in the real office</summary>
                  <img src={asset('assets/room-panel.png')} width={1440} height={900} loading="lazy" decoding="async"
                    alt="A room's panel: the sessions in the Cedar room, each with its state, and the Server and Edit room buttons." />
                </details>
              </div>
            </article>
            <article className="card">
              <Vignette kind="manager" />
              <div className="card__body">
                <h3>{copy.manager.title}</h3>
                <Html as="p" html={copy.manager.html} />
                <details className="card__shot">
                  <summary>See it in the real office</summary>
                  <img src={asset('assets/feature-manager.png')} width={800} height={500} loading="lazy" decoding="async"
                    alt="Headquarters in the middle of the office: the manager, Luady, at its desk." />
                </details>
              </div>
            </article>
          </div>
          <figure className="real">
            <div className="real__screen">
              <picture>
                <source media="(prefers-reduced-motion: reduce)" srcSet={asset('assets/office.png')} />
                <img src={asset('assets/office-demo.webp')} width={800} height={500} loading="lazy" decoding="async"
                  alt="The Luady office in a browser. Rooms for the servers Cedar and Birch sit around the manager's headquarters. A room is added for the server ash, then the camera moves from room to room and back to the whole office." />
              </picture>
            </div>
            <div className="real__phone">
              <img src={asset('assets/phone.png')} width={390} height={844} loading="lazy" decoding="async"
                alt="The office on a phone-sized screen: HQ in the middle of the map, with the manager, Luady, at its desk, and the chat line at the bottom: Tell Luady something." />
            </div>
            <figcaption>The real website against a pretend fleet: a room is added for the server <code>ash</code>, then the camera moves between rooms. On a phone, the same office.</figcaption>
          </figure>
        </Room>

        <Room id="set-up" colour="cyan" title="Set up from your browser"
          lead={<><code>npm start</code> prints a one-time setup code in the terminal. Open <code>http://localhost:7410</code> and the setup wizard takes it from there, in six steps.</>}>
          <ol className="steps">
            <li className="step">
              <div className="step__text">
                <p className="step__no">Step 1</p>
                <h3>Claim the hub</h3>
                <p>Type the setup code from the terminal, then create a passkey on this device: your fingerprint, face, screen lock or security key.</p>
              </div>
              <div className="step__shot"><img src={asset('assets/setup-claim.png')} width={880} height={560} loading="lazy" decoding="async" alt="Step 1 of 6 of the setup wizard, Claim this install: a field for the setup code, an optional device name, and Create a passkey." /></div>
            </li>
            <li className="step">
              <div className="step__text">
                <p className="step__no">Step 2</p>
                <h3>Choose a PIN</h3>
                <p>6 to 12 digits. The hub asks for it before risky actions, such as stopping a session, adding a server or writing a file on one.</p>
              </div>
              <div className="step__shot"><img src={asset('assets/setup-pin.png')} width={880} height={560} loading="lazy" decoding="async" alt="Step 2 of 6, Choose a PIN: a New PIN field, a Repeat PIN field and a Save PIN button." /></div>
            </li>
            <li className="step">
              <div className="step__text">
                <p className="step__no">Step 3</p>
                <h3>Add this computer or a server</h3>
                <p>Add a machine and a room for each. For a server, paste one line on it, compare its fingerprint, and the hub installs the kit for you.</p>
              </div>
              <div className="step__shot"><img src={asset('assets/setup-rooms.png')} width={880} height={560} loading="lazy" decoding="async" alt="Step 3 of 6, Add your rooms: two empty lots, Add this computer and Add a server. A server needs SSH as a normal user, python3, tmux and Claude Code." /></div>
            </li>
            <li className="step">
              <div className="step__text">
                <p className="step__no">Steps 4 to 6</p>
                <h3>Open the office</h3>
                <p>Check each machine&rsquo;s kit and sign in to Claude on it, choose the extras (all off unless you switch them on), and open the office. You can skip steps 3 to 5 and come back to them in Settings.</p>
              </div>
              <div className="step__shot"><img src={asset('assets/setup-open.png')} width={880} height={605} loading="lazy" decoding="async" alt="Step 6 of 6, Open the office: a summary of the rooms, the machines, the manager (off) and what was left for later, and an Open the office button." /></div>
            </li>
          </ol>
          <div className="run">
            <div className="run__block">
              <h3>Try it on your computer</h3>
              <Html as="p" html={copy.tryLead} />
              <Code lines={copy.tryCode} />
              <Html as="p" className="run__note" html={copy.tryNote} />
            </div>
            <div className="run__block">
              <h3>Run it for real</h3>
              <Html as="p" html={copy.runNeeds} />
              <Code lines={copy.runCode} />
              <Html as="p" className="run__note" html={copy.runNote} />
            </div>
          </div>
          <ul className="more" aria-label="Step by step">
            <li><a href={href('docs/getting-started/')}>Getting started</a></li>
            <li><a href={href('docs/setup-wizard/')}>The setup wizard</a></li>
            <li><a href={href('docs/servers/')}>Adding servers</a></li>
          </ul>
        </Room>

        <Room id="how-it-works" colour="teal" title="How it works">
          <div className="how">
            <figure className="how__figure" dangerouslySetInnerHTML={{ __html: howItWorksSvg() }} />
            <ul className="how__list">
              {copy.how.map((item, i) => <Html as="li" key={i} html={item} />)}
            </ul>
          </div>
          <ul className="more" aria-label="More about how it works">
            <li><a href={href('docs/')}>Read the docs</a></li>
            <li><a href={href('docs/addons/')}>Add-ons and the SDK</a></li>
          </ul>
        </Room>

        <Room id="security" colour="orange" title="Careful by default"
          lead="Luady steers sessions that can change code and run commands on your servers. Here is what the hub protects, and how.">
          <div className="guard">
            <div className="warn" role="note">
              <p className="warn__title">Read this first</p>
              <Html as="p" html={copy.permission} />
            </div>
            <ul className="guard__list">
              {copy.security.map((item, i) => <Html as="li" key={i} html={item} />)}
            </ul>
          </div>
          <ul className="more" aria-label="More about security">
            <li><a href={href('docs/security/')}>The security page</a></li>
            <li><a href={blob('SECURITY.md')}>Report a vulnerability privately</a></li>
          </ul>
        </Room>

        <Room id="open-source" colour="violet" title="Open source">
          <div className="cards cards--three">
            <div className="card card--plain">
              <h3>The licence</h3>
              <p>Luady is licensed under the <a href={blob('LICENSE')}>Apache License 2.0</a>. Copyright The Luady Authors. See also <a href={blob('NOTICE')}>NOTICE</a>.</p>
            </div>
            <div className="card card--plain">
              <h3>Contribute</h3>
              <p>Bug reports, fixes, docs and add-ons are welcome. Please read <a href={blob('CONTRIBUTING.md')}>CONTRIBUTING.md</a> first. The <a href={`${REPO_URL}/tree/${BRANCH}/packages/addon-sdk`}>add-on SDK</a> comes with a working example.</p>
            </div>
            <div className="card card--plain">
              <h3>Report a security problem</h3>
              <p>Never in a public issue. Report it privately, as <a href={blob('SECURITY.md')}>SECURITY.md</a> describes.</p>
            </div>
          </div>
          <p className="aside">Luady is not affiliated with Anthropic. &ldquo;Claude&rdquo; and &ldquo;Claude Code&rdquo; are Anthropic&rsquo;s names.</p>
        </Room>

        <section className="last" aria-labelledby="last-title">
          <div className="wrap last__in">
            <img className="last__logo" src={asset('brand/logo.svg')} width={144} height={144} loading="lazy" decoding="async" alt="" />
            <h2 id="last-title">See the office for yourself</h2>
            {demo === null ? (
              <p>Run the demo on your computer: the real hub with a pretend fleet, and nothing real is contacted.</p>
            ) : (
              <p>The live demo loads nothing from anywhere else, and the rooms you add are gone when you reload.</p>
            )}
            <div className="hero__actions last__actions">
              {demo === null ? null : <a className="btn btn--primary" href={demo}>Try the live demo</a>}
              <a className={demo === null ? 'btn btn--primary' : 'btn'} href={href('docs/getting-started/')}>Get started</a>
            </div>
          </div>
        </section>
      </main>
      <Footer demo={HAS_DEMO} />
      <Assemble />
      <CopyButtons />
    </>
  );
}
