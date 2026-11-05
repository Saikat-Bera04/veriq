import { MotionConfig } from 'framer-motion'
import { SmoothScroll } from '@/components/landing/SmoothScroll'
import { Navbar } from '@/components/landing/Navbar'
import { Hero } from '@/components/landing/Hero'
import { MeetVeriq } from '@/components/landing/MeetVeriq'
import { CoreFeatures } from '@/components/landing/CoreFeatures'
import { UseModes } from '@/components/landing/UseModes'
import { StackWall } from '@/components/landing/StackWall'
import { VeriqFooter } from '@/components/VeriqFooter'

export { LogoIcon } from '@/components/landing/primitives'

// 1 Nav · 2 Hero · 3 Meet Veriq · 4 Core features · 5 Use modes · 6 Works with your stack · 7 Footer
export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <SmoothScroll>
        <div className="flex min-h-screen flex-col bg-[#F5F5F5]">
          <Navbar />
          <main>
            <Hero />
            <MeetVeriq />
            <CoreFeatures />
            <UseModes />
            <StackWall />
          </main>
          <VeriqFooter />
        </div>
      </SmoothScroll>
    </MotionConfig>
  )
}
