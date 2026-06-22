import { useState } from 'react';
import SearchInput from '../components/SearchInput';
import { getDefaultDepth, getDefaultMode } from '../hooks/useDefaultMode';
import type { DeepDepth, SearchMode } from '../lib/api';

const HEADLINES = [
  'Know thyself.',
  'I think, therefore I am.',
  'Existence precedes essence.',
  'To be is to be perceived.',
  'God is dead.',
  'The will to power.',
  'The unexamined life.',
  'Man is a social animal.',
  'All is water.',
  'The eternal recurrence.',
  'Becoming is being.',
  'Feeling is understanding.',
  'Nothing comes from nothing.',
  'The art of living.',
  'Truth and method.',
  'The other is hell.',
  'Freedom is loneliness.',
  'Language is a virus.',
  'Nature abhors a vacuum.',
  'Time is a child.',
  'Reality is negotiable.',
  'Action over contemplation.',
  'The middle path.',
  'Simplify, then simplify.',
  'Only ideals matter.',
  'Live on the edge.',
  'All is number.',
  'Freedom is terrifying.',
  'The aim is the good.',
  'Wonder is wisdom\'s start.',
  'Suffering is beauty.',
  'Despair is the price.',
  'Man is a political animal.',
  'Doubt everything.',
  'There is no truth.',
  'The whole is the false.',
  'Know your limits.',
  'Love is a serious mental disease.',
  'To endure is everything.',
  'We are our choices.',
  'Silence is knowledge.',
  'Heed the silence.',
  'Think for yourself.',
  'Life is a dream.',
  'All is vanity.',
  'The middle way.',
  'Act justly.',
  'Truth is subjective.',
  'Becoming who you are.',
  'Own your being.',
  'Existence is suffering.',
  'Awake and act.',
  'The die is cast.',
  'I know nothing.',
  'Virtue is knowledge.',
  'Know your nature.',
  'Reason is slave.',
  'The golden mean.',
  'Freedom requires courage.',
  'Conscience is internalized authority.',
];

const SUBTITLES = [
  'The only true wisdom is in knowing you know nothing.',
  'We suffer more often in imagination than in reality.',
  'No man ever steps in the same river twice, for it is not the same river and he is not the same man.',
  'It is not that we have a short time to live, but that we waste a lot of it.',
  'The first step in the evolution of ethics is a sense of solidarity with other human beings.',
  'To have a right to do a thing is not at all the same as to be right in doing it.',
  'He who thinks great thoughts often makes great errors.',
  'There is only one good, knowledge, and one evil, ignorance.',
  'Courage is knowing what not to fear.',
  'The greatest wealth is to live content with little.',
  'I slept and dreamt that life was joy. I awoke and saw that life was service. I acted and behold, service was joy.',
  'Man cannot stand a meaningless life.',
  'We are what we repeatedly do. Excellence, then, is not an act, but a habit.',
  'In the midst of chaos, there is also opportunity.',
  'To know what you know and what you do not know, that is true knowledge.',
  'The happiness of your life depends on the quality of your thoughts.',
  'Doubt is the key to knowledge.',
  'A man is but what he knows.',
  'The foolish man seeks happiness in the distance; the wise grows it under his feet.',
  'He who has a why to live can bear almost any how.',
  'What is rational is actual and what is actual is rational.',
  'The function of prayer is not to influence God, but rather to change the nature of the one who prays.',
  'The mystery of human existence lies not in just staying alive, but in finding something to live for.',
  'The more I read, the more I acquire, the more certain I am that I know nothing.',
  'For to be free is not merely to cast off one\'s chains, but to live in a way that respects and enhances the freedom of others.',
  'The opposite of a correct statement is a false statement. The opposite of a profound truth may well be another profound truth.',
  'We are like islands in the sea, separate on the surface but connected in the deep.',
  'Every genuine work of art has as much reason for being as the earth and the sun.',
  'One repays a teacher badly if one remains only a pupil.',
  'Science is what you know. Philosophy is what you don\'t know.',
  'All that we see or seem is but a dream within a dream.',
  'The heart has its reasons of which reason knows nothing.',
  'A very great deal more truth can become known in a novel than in a philosophical treatise.',
  'The most courageous act is still to think for yourself. Aloud.',
  'Boredom is the root of all evil — the dread of the nothingness of existence.',
  'When memory is overwhelmed, we turn to history.',
  'The art of being wise is the art of knowing what to overlook.',
  'Logic takes you from A to B; imagination takes you everywhere.',
  'A philosopher is a blind man in a dark room looking for a black cat that isn\'t there.',
  'Happiness depends upon ourselves.',
  'Freedom is the only worthy end in itself.',
  'No man was ever wise by chance.',
  'The greater the difficulty, the more the glory in surmounting it.',
  'What you leave behind is not what is engraved in stone monuments, but what is woven into the lives of others.',
  'The soul becomes dyed with the color of its thoughts.',
  'It is impossible to live a pleasant life without living wisely and well.',
  'The whole is greater than the sum of its parts.',
  'Pleasure is the beginning and the end of living happily.',
  'Not to know what happened before one was born is always to remain a child.',
  'The only way to have a friend is to be one.',
  'If you wish to make an apple pie from scratch, you must first invent the universe.',
  'The death of one man is a tragedy; the death of millions is a statistic.',
  'Good people do not need laws to tell them to act responsibly, while bad people will find a way around the laws.',
  'The first and greatest victory is to conquer yourself.',
  'To live is to change, and to be perfect is to have changed often.',
  'Love is composed of a single soul inhabiting two bodies.',
  'The worst form of inequality is to try to make unequal things equal.',
  'Wise men speak because they have something to say; fools because they have to say something.',
  'Better to trip with the feet than with the tongue.',
  'The only real valuable thing is intuition.',
  'A life without examination is not worth living.',
  'Everything that is beautiful and noble is the product of reason and calculation.',
  'The ascent of man is measured by his capacity for compassion.',
  'If you want to find the secrets of the universe, think in terms of energy, frequency and vibration.',
  'Nature does nothing in vain.',
  'Injustice anywhere is a threat to justice everywhere.',
  'We think too much and feel too little.',
  'The measure of a man is what he does with power.',
  'A true philosopher is someone who does not practice philosophy for the sake of appearances.',
  'The most difficult thing is the decision to act; the rest is merely tenacity.',
  'It is not enough to have a good mind; the main thing is to use it well.',
  'To understand the heart and mind of a person, look not at what they have achieved, but at what they aspire to.',
  'Everything that irritates us about others can lead us to an understanding of ourselves.',
  'The interpretation of dreams is the royal road to a knowledge of the unconscious.',
  'Where love rules, there is no will to power; and where power predominates, love is lacking.',
  'Man is the measure of all things.',
  'You cannot step into the same river twice.',
  'All human actions have one or more of these seven causes: chance, nature, compulsion, habit, reason, passion, desire.',
  'The life of the dead is placed in the memory of the living.',
];

interface FooterQuote {
  text: string;
  author: string;
}

const FOOTER_QUOTES: FooterQuote[] = [
  { text: 'Doubt is the origin of wisdom.', author: 'René Descartes' },
  { text: 'The greatest glory in living lies not in never falling, but in rising every time we fall.', author: 'Nelson Mandela' },
  { text: 'To live is to suffer, to survive is to find some meaning in the suffering.', author: 'Friedrich Nietzsche' },
  { text: 'The further a society drifts from truth, the more it will hate those who speak it.', author: 'George Orwell' },
  { text: 'The welfare of the people in particular has always been the alibi of tyrants.', author: 'Albert Camus' },
  { text: 'Man is the only creature who refuses to be what he is.', author: 'Albert Camus' },
  { text: 'The unexamined life is not worth living.', author: 'Socrates' },
  { text: 'The beginning of wisdom is the definition of terms.', author: 'Socrates' },
  { text: 'We are what we repeatedly do. Excellence, then, is not an act, but a habit.', author: 'Aristotle' },
  { text: 'It is the mark of an educated mind to be able to entertain a thought without accepting it.', author: 'Aristotle' },
  { text: 'He who commits injustice is ever made more wretched than he who suffers it.', author: 'Plato' },
  { text: 'The heaviest penalty for declining to rule is to be ruled by someone inferior to yourself.', author: 'Plato' },
  { text: 'A man cannot be comfortable without his own approval.', author: 'Mark Twain' },
  { text: 'The only way to deal with an unfree world is to become so absolutely free that your very existence is an act of rebellion.', author: 'Albert Camus' },
  { text: 'The master has failed more times than the beginner has even tried.', author: 'Stephen McCranie' },
  { text: 'If you are neutral in situations of injustice, you have chosen the side of the oppressor.', author: 'Desmond Tutu' },
  { text: 'In a world where death is the hunter, my friend, there is no time for regrets or doubts. There is only time for decisions.', author: 'Carlos Castaneda' },
  { text: 'The Tao that can be told is not the eternal Tao. The name that can be named is not the eternal name.', author: 'Lao Tzu' },
  { text: 'Those who know do not speak. Those who speak do not know.', author: 'Lao Tzu' },
  { text: 'It does not matter how slowly you go as long as you do not stop.', author: 'Confucius' },
  { text: 'Our greatest glory is not in never falling, but in rising every time we fall.', author: 'Confucius' },
  { text: 'The world is full of obvious things which nobody by any chance ever observes.', author: 'Arthur Conan Doyle' },
  { text: 'The curious paradox is that when I accept myself just as I am, then I can change.', author: 'Carl Rogers' },
  { text: 'Life can only be understood backwards; but it must be lived forwards.', author: 'Søren Kierkegaard' },
  { text: 'Anxiety is the dizziness of freedom.', author: 'Søren Kierkegaard' },
  { text: 'One must imagine Sisyphus happy.', author: 'Albert Camus' },
  { text: 'The privilege of a lifetime is to become who you truly are.', author: 'Carl Jung' },
  { text: 'Until you make the unconscious conscious, it will direct your life and you will call it fate.', author: 'Carl Jung' },
  { text: 'I am not what happened to me, I am what I choose to become.', author: 'Carl Jung' },
  { text: 'What is to give light must endure burning.', author: 'Viktor Frankl' },
  { text: 'When we are no longer able to change a situation, we are challenged to change ourselves.', author: 'Viktor Frankl' },
  { text: 'Freedom is the will to be responsible for ourselves.', author: 'Friedrich Nietzsche' },
  { text: 'The individual has always had to struggle to keep from being overwhelmed by the tribe.', author: 'Friedrich Nietzsche' },
  { text: 'It is difficult to free fools from the chains they revere.', author: 'Voltaire' },
  { text: 'Judge a man by his questions rather than by his answers.', author: 'Voltaire' },
  { text: 'Every man is guilty of all the good he did not do.', author: 'Voltaire' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'The most beautiful thing we can experience is the mysterious.', author: 'Albert Einstein' },
  { text: 'Imagination is more important than knowledge.', author: 'Albert Einstein' },
  { text: 'The reasonable man adapts himself to the world; the unreasonable one persists in trying to adapt the world to himself.', author: 'George Bernard Shaw' },
  { text: 'The only thing necessary for the triumph of evil is for good men to do nothing.', author: 'Edmund Burke' },
  { text: 'Those who cannot remember the past are condemned to repeat it.', author: 'George Santayana' },
  { text: 'The price of apathy towards public affairs is to be ruled by evil men.', author: 'Plato' },
  { text: 'We are all born ignorant, but one must work hard to remain stupid.', author: 'Benjamin Franklin' },
  { text: 'A man is but what he knows.', author: 'Francis Bacon' },
  { text: 'Knowledge itself is power.', author: 'Francis Bacon' },
  { text: 'To be happy, we must not be too concerned with others.', author: 'Albert Camus' },
  { text: 'Life is not a problem to be solved, but a reality to be experienced.', author: 'Søren Kierkegaard' },
  { text: 'Beware that, when fighting monsters, you yourself do not become a monster.', author: 'Friedrich Nietzsche' },
  { text: 'When you gaze long into an abyss, the abyss also gazes into you.', author: 'Friedrich Nietzsche' },
  { text: 'Thinking is the hardest work there is, which is probably the reason why so few engage in it.', author: 'Henry Ford' },
  { text: 'The problem with the world is that the intelligent people are full of doubts, while the stupid ones are full of confidence.', author: 'Charles Bukowski' },
  { text: 'Man will never be free until the last king is strangled with the entrails of the last priest.', author: 'Denis Diderot' },
  { text: 'The limits of the possible can only be defined by going beyond them into the impossible.', author: 'Arthur C. Clarke' },
  { text: 'You cannot swim for new horizons until you have courage to lose sight of the shore.', author: 'William Faulkner' },
  { text: 'Two things are infinite: the universe and human stupidity; and I\'m not sure about the universe.', author: 'Albert Einstein' },
  { text: 'There is no greatness where there is no simplicity.', author: 'Leo Tolstoy' },
  { text: 'Everyone thinks of changing the world, but no one thinks of changing himself.', author: 'Leo Tolstoy' },
  { text: 'The truth is rarely pure and never simple.', author: 'Oscar Wilde' },
  { text: 'Most people are other people. Their thoughts are someone else\'s opinions, their lives a mimicry, their passions a quotation.', author: 'Oscar Wilde' },
  { text: 'The aim of art is to represent not the outward appearance of things, but their inward significance.', author: 'Aristotle' },
  { text: 'Ethics is nothing else than reverence for life.', author: 'Albert Schweitzer' },
  { text: 'The first condition of understanding a foreign country is to smell it.', author: 'Rudyard Kipling' },
  { text: 'You must look into people, as well as at them.', author: 'Lord Chesterfield' },
  { text: 'The deepest principle in human nature is the craving to be appreciated.', author: 'William James' },
  { text: 'Human happiness and moral duty are inseparably connected.', author: 'Immanuel Kant' },
  { text: 'Science without religion is lame, religion without science is blind.', author: 'Albert Einstein' },
  { text: 'Common sense is the collection of prejudices acquired by age eighteen.', author: 'Albert Einstein' },
  { text: 'The strongest of all warriors are these two — Time and Patience.', author: 'Leo Tolstoy' },
  { text: 'If you look for truth, you may find comfort in the end; if you look for comfort you will not get either comfort or truth.', author: 'C.S. Lewis' },
  { text: 'The well of inspiration runs dry when you stop questioning.', author: 'Voltaire' },
  { text: 'It is better to be feared than loved, if you cannot be both.', author: 'Niccolò Machiavelli' },
  { text: 'The ends justify the means.', author: 'Niccolò Machiavelli' },
  { text: 'I learned that courage was not the absence of fear, but the triumph over it.', author: 'Nelson Mandela' },
  { text: 'The function of education is to teach one to think intensively and to think critically.', author: 'Martin Luther King Jr.' },
  { text: 'There is no passion to be found playing small — in settling for a life that is less than the one you are capable of living.', author: 'Nelson Mandela' },
  { text: 'In the middle of difficulty lies opportunity.', author: 'Albert Einstein' },
  { text: 'It is better to be violent, if there is violence in our hearts, than to put on the cloak of nonviolence to cover impotence.', author: 'Mahatma Gandhi' },
  { text: 'Happiness is when what you think, what you say, and what you do are in harmony.', author: 'Mahatma Gandhi' },
  { text: 'An eye for an eye only ends up making the whole world blind.', author: 'Mahatma Gandhi' },
  { text: 'A man is but the product of his thoughts. What he thinks, he becomes.', author: 'Mahatma Gandhi' },
  { text: 'Truth never damages a cause that is just.', author: 'Mahatma Gandhi' },
  { text: 'It may be possible to gild pure gold, but who can make his mother more beautiful?', author: 'Mahatma Gandhi' },
  { text: 'To sin by silence when they should protest makes cowards of men.', author: 'Abraham Lincoln' },
  { text: 'Give me six hours to chop down a tree and I will spend the first four sharpening the axe.', author: 'Abraham Lincoln' },
  { text: 'In the end, it\'s not the years in your life that count. It\'s the life in your years.', author: 'Abraham Lincoln' },
  { text: 'The best way to predict the future is to create it.', author: 'Peter Drucker' },
  { text: 'No one can make you feel inferior without your consent.', author: 'Eleanor Roosevelt' },
  { text: 'Great minds discuss ideas; average minds discuss events; small minds discuss people.', author: 'Eleanor Roosevelt' },
  { text: 'The only thing to do with good advice is to pass it on. It is never of any use to oneself.', author: 'Oscar Wilde' },
  { text: 'To live is the rarest thing in the world. Most people exist, that is all.', author: 'Oscar Wilde' },
  { text: 'Toleration is the greatest gift of the mind; it requires the same effort of the brain that it takes to balance oneself on a bicycle.', author: 'Helen Keller' },
  { text: 'Life is either a daring adventure or nothing at all.', author: 'Helen Keller' },
  { text: 'The highest result of education is tolerance.', author: 'Helen Keller' },
  { text: 'The essence of philosophy is that a man should so live that his happiness shall depend as little as possible on external things.', author: 'Epictetus' },
  { text: 'Wealth consists not in having great possessions, but in having few wants.', author: 'Epictetus' },
  { text: 'It\'s not what happens to you, but how you react to it that matters.', author: 'Epictetus' },
  { text: 'First say to yourself what you would be; then do what you have to do.', author: 'Epictetus' },
  { text: 'Freedom is secured not by the fulfilling of one\'s desires, but by the removal of desire.', author: 'Epictetus' },
  { text: 'The happiness of your life depends upon the quality of your thoughts.', author: 'Marcus Aurelius' },
  { text: 'The soul becomes dyed with the color of its thoughts.', author: 'Marcus Aurelius' },
  { text: 'Very little is needed to make a happy life; it is all within yourself, in your way of thinking.', author: 'Marcus Aurelius' },
  { text: 'The object of life is not to be on the side of the majority, but to escape finding oneself in the ranks of the insane.', author: 'Marcus Aurelius' },
  { text: 'Waste no more time arguing about what a good man should be. Be one.', author: 'Marcus Aurelius' },
  { text: 'Everything we hear is an opinion, not a fact. Everything we see is a perspective, not the truth.', author: 'Marcus Aurelius' },
  { text: 'The universe is change; our life is what our thoughts make it.', author: 'Marcus Aurelius' },
  { text: 'Death smiles at us all, but all a man can do is smile back.', author: 'Marcus Aurelius' },
  { text: 'Accept the things to which fate binds you, and love the people with whom fate brings you together, but do so with all your heart.', author: 'Marcus Aurelius' },
  { text: 'The art of living is more like wrestling than dancing.', author: 'Marcus Aurelius' },
  { text: 'The happiness of your life depends upon the quality of your thoughts.', author: 'Marcus Aurelius' },
  { text: 'If you are distressed by anything external, the pain is not due to the thing itself, but to your estimate of it; and this you have the power to revoke at any moment.', author: 'Marcus Aurelius' },
  { text: 'To stand on the edge of the abyss and not be afraid is the beginning of freedom.', author: 'Marcus Aurelius' },
  { text: 'When you wake up in the morning, tell yourself: the people I deal with today will be meddling, ungrateful, arrogant, dishonest, jealous, and surly.', author: 'Marcus Aurelius' },
  { text: 'The best revenge is to be unlike him who performed the injury.', author: 'Marcus Aurelius' },
  { text: 'Dignity consists not in our possessions but in what we are.', author: 'Marcus Aurelius' },
  { text: 'We are too much accustomed to attribute to a single cause that which is the product of several.', author: 'Marcus Aurelius' },
  { text: 'The universe is transformation; life is opinion.', author: 'Marcus Aurelius' },
  { text: 'The only wealth which you will keep forever is the wealth you have given away.', author: 'Marcus Aurelius' },
  { text: 'The time is always right to do what is right.', author: 'Martin Luther King Jr.' },
  { text: 'Change does not roll in on the wheels of inevitability, but comes through continuous struggle.', author: 'Martin Luther King Jr.' },
  { text: 'Faith is taking the first step even when you don\'t see the whole staircase.', author: 'Martin Luther King Jr.' },
  { text: 'Nothing in the world is more dangerous than sincere ignorance and conscientious stupidity.', author: 'Martin Luther King Jr.' },
  { text: 'The ultimate measure of a man is not where he stands in moments of comfort and convenience, but where he stands at times of challenge and controversy.', author: 'Martin Luther King Jr.' },
  { text: 'A ship is always safe at the shore — but that is not what it is built for.', author: 'Albert Einstein' },
  { text: 'Insanity: doing the same thing over and over again and expecting different results.', author: 'Albert Einstein' },
  { text: 'We cannot solve our problems with the same thinking we used when we created them.', author: 'Albert Einstein' },
  { text: 'Gravitation is not responsible for people falling in love.', author: 'Albert Einstein' },
  { text: 'The value of a man should be seen in what he gives and not in what he is able to receive.', author: 'Albert Einstein' },
  { text: 'Meaning is not an object waiting to be discovered in the world; it is an architecture constructed by the mind in its endeavor to impose order upon chaos.', author: 'ATHENA' },
];

const PLACEHOLDERS = [
  'Enter the void...',
  'Pose your question...',
  'Confess your ignorance...',
  'State your inquiry...',
  'Ask the abyss...',
  'Propose a problem...',
  'Seek what you lack...',
  'Articulate your doubt...',
  'Declare your quest...',
  'Name the unnamable...',
  'Dare to ask...',
  'Expose your curiosity...',
  'Formulate your wonder...',
  'Utter the unutterable...',
  'Break the silence...',
  'What perplexes you?',
  'Cast your question into the dark...',
  'Speak, if you dare...',
  'The oracle awaits...',
  'What troubles your soul?',
  'Ask wisely — answers are cheap.',
  'Type your confusion...',
  'What do you think you know?',
  'Feed the algorithm your doubt...',
  'Every answer begins in error.',
  'Your ignorance, please.',
  'What is it to you?',
  'Uncertain? Good.',
  'Question everything, starting here.',
  'I know nothing. You?',
  'The answer is not the point.',
  'Wonder is the beginning.',
  'What haunts you?',
  'State your case.',
  'Curiosity was our fall.',
  'Ask and you shall be misled.',
  'Another question for the void?',
  'The wisest confess their ignorance.',
  'Proceed with doubt.',
  'What remains unknown?',
  'Inquire within.',
  'Truth awaits your question.',
  'Wonder aloud.',
  'Let your confusion speak.',
  'The unasked question haunts.',
  'Doubt enters here.',
  'Empty your certainty here.',
  'What is your question, pilgrim?',
  'The first step is admitting confusion.',
  'All answers are temporary.',
];

interface LandingProps {
  onSearch: (query: string, mode?: SearchMode, depth?: DeepDepth) => void;
}

export default function Landing({ onSearch }: LandingProps) {
  const defaultMode = getDefaultMode();
  const defaultDepth = getDefaultDepth();
  const [exiting, setExiting] = useState(false);
  const [shatter, setShatter] = useState(0);
  const [filterId] = useState(() => `shatter-${Math.random().toString(36).slice(2, 9)}`);
  const [headline] = useState(() => HEADLINES[Math.floor(Math.random() * HEADLINES.length)]);
  const [subtitle] = useState(() => SUBTITLES[Math.floor(Math.random() * SUBTITLES.length)]);
  const [footer] = useState(() => FOOTER_QUOTES[Math.floor(Math.random() * FOOTER_QUOTES.length)]);
  const [placeholder] = useState(() => PLACEHOLDERS[Math.floor(Math.random() * PLACEHOLDERS.length)]);

  const handleSearch = (query: string, mode?: SearchMode, depth?: DeepDepth) => {
    setExiting(true);
    const start = performance.now();
    const duration = 500;
    function tick(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setShatter(eased * 60);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    setTimeout(() => onSearch(query, mode, depth), 550);
  };

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      <svg style={{ position: 'absolute', width: 0, height: 0, zIndex: -1 }} aria-hidden="true">
        <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves="4" result="noise" />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale={shatter} xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <div
        style={{
          position: 'relative',
          height: '100%',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
          overflow: 'hidden auto',
          filter: exiting ? `url(#${filterId})` : undefined,
          opacity: exiting ? Math.max(0, 1 - shatter / 60) : 1,
        }}
      >
      <div
        style={{
          width: '100%',
          maxWidth: 600,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 0,
        }}
      >
        {/* Eyebrow */}
        <div
          className="font-mono"
          style={{
            fontSize: 9,
            letterSpacing: '0.35em',
            textTransform: 'uppercase',
            color: 'var(--athena-text-3)',
            marginBottom: 16,
            animation: 'fade-in-up 0.5s var(--ease-out) both',
          }}
        >
          ATHENA / 001
        </div>

        {/* Headline */}
        <h1
          className="font-outfit"
          style={{
            fontSize: 'clamp(2.2rem, 5.5vw, 3.6rem)',
            fontWeight: 300,
            letterSpacing: '-0.04em',
            lineHeight: 1.06,
            color: 'var(--athena-text)',
            margin: 0,
            marginBottom: 12,
            textAlign: 'center',
            animation: 'fade-in-up 0.5s 0.06s var(--ease-out) both',
          }}
        >
          {headline}
        </h1>

        {/* Subtitle */}
        <p
          style={{
            fontSize: 14.5,
            lineHeight: 1.65,
            color: 'var(--athena-text-2)',
            margin: 0,
            maxWidth: 460,
            textWrap: 'balance',
            textAlign: 'center',
            animation: 'fade-in-up 0.5s 0.12s var(--ease-out) both',
          } as React.CSSProperties}
        >
          {subtitle}
        </p>

        {/* Search */}
        <div
          style={{
            width: '100%',
            marginTop: 28,
            marginBottom: 8,
            animation: 'fade-in-up 0.5s 0.18s var(--ease-out) both',
          }}
        >
          <SearchInput onSubmit={handleSearch} autoFocus initialMode={defaultMode} initialDepth={defaultDepth} placeholder={placeholder} />
        </div>

        {/* Footer quote */}
        <div
          style={{
            marginTop: 28,
            textAlign: 'center',
            animation: 'fade-in 0.6s 0.5s var(--ease-out) both',
          }}
        >
          <p
            style={{
              fontSize: 12,
              lineHeight: 1.55,
              color: 'var(--athena-text-2)',
              margin: 0,
              fontStyle: 'italic',
              maxWidth: 420,
            }}
          >
            {footer.text}
          </p>
          <p
            className="font-mono"
            style={{
              fontSize: 8.5,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--athena-text-3)',
              margin: '6px 0 0',
            }}
          >
            — {footer.author}
          </p>
        </div>
      </div>
    </div>
    </div>
  );
}
